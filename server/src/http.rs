//! HTTP layer: axum server exposing every command as `POST /api/rpc/<cmd>`
//! (JSON args in, JSON result out — a 1:1 replacement for Tauri `invoke`),
//! plus SSE events, backup download/upload and the built frontend as static
//! files.

use std::convert::Infallible;

use axum::extract::{DefaultBodyLimit, Path as UrlPath, State};
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};
use tower_http::services::{ServeDir, ServeFile};

use crate::host::AppHandle;

/// Import/restore payloads can be large (a year of statements as JSON rows,
/// a multi-megabyte DB in a ZIP) — axum's 2 MB default is far too small.
const BODY_LIMIT_BYTES: usize = 512 * 1024 * 1024;

pub async fn serve(app: AppHandle) {
    let bind = std::env::var(crate::ENV_BIND).unwrap_or_else(|_| crate::DEFAULT_BIND.to_string());
    let static_dir =
        std::env::var(crate::ENV_STATIC_DIR).unwrap_or_else(|_| "./static".to_string());
    let index = std::path::Path::new(&static_dir).join("index.html");

    let router = Router::new()
        .route("/api/rpc/{cmd}", post(rpc))
        .route("/api/events", get(events))
        .route("/api/backup", get(backup))
        .route("/api/restore", post(restore))
        .route("/api/health", get(|| async { "ok" }))
        .fallback_service(ServeDir::new(&static_dir).fallback(ServeFile::new(index)))
        .layer(DefaultBodyLimit::max(BODY_LIMIT_BYTES))
        .with_state(app);

    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {bind}: {e}"));
    eprintln!("finances-server listening on http://{bind}");
    axum::serve(listener, router).await.expect("server error");
}

fn ok<T: serde::Serialize>(value: T) -> Response {
    Json(value).into_response()
}

fn err(message: String) -> Response {
    // Command errors are strings (often stable codes the frontend localises);
    // deliver them as plain text so the client can rethrow them verbatim.
    (StatusCode::BAD_REQUEST, message).into_response()
}

fn respond<T: serde::Serialize>(result: Result<T, String>) -> Response {
    match result {
        Ok(value) => ok(value),
        Err(message) => err(message),
    }
}

/// SSE stream of backend events. Each message is a JSON object
/// `{event, payload}`; the frontend's `listen()` filters by `event`.
async fn events(
    State(app): State<AppHandle>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = app.0.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|msg| match msg {
        Ok(value) => Some(Ok(Event::default().data(value.to_string()))),
        // Lagged receiver — the missed events are gone; keep streaming.
        Err(_) => None,
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Stream the current DB as a single-entry ZIP download.
async fn backup(State(app): State<AppHandle>) -> Response {
    match crate::backup::backup_zip_bytes(app.db()) {
        Ok(bytes) => {
            let filename = format!(
                "finances-backup-{}.zip",
                chrono::Utc::now().format("%Y-%m-%d")
            );
            (
                [
                    (header::CONTENT_TYPE, "application/zip".to_string()),
                    (
                        header::CONTENT_DISPOSITION,
                        format!("attachment; filename=\"{filename}\""),
                    ),
                ],
                bytes,
            )
                .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// Accept an uploaded backup ZIP (raw request body), validate and install it,
/// then reopen the DB in-process. The frontend reloads the page afterwards.
async fn restore(State(app): State<AppHandle>, body: axum::body::Bytes) -> Response {
    match crate::backup::restore_from_zip_bytes(&app, &body) {
        Ok(()) => ok(Value::Null),
        Err(e) => err(e),
    }
}

async fn rpc(
    State(app): State<AppHandle>,
    UrlPath(cmd): UrlPath<String>,
    body: Option<Json<Value>>,
) -> Response {
    let args = body.map(|Json(v)| v).unwrap_or_else(|| Value::Object(Default::default()));

    /// One dispatch arm: deserialize the camelCase JSON args into the
    /// command's parameters and call it. Variants by first parameter(s):
    /// `state` = `(State<DbState>, ...)`, `app_state` = `(AppHandle,
    /// State<DbState>, ...)`, `app_async` = `async (AppHandle, ...)`,
    /// `plain` = no shared state at all.
    macro_rules! run {
        (state $f:path) => {
            respond($f(app.db()))
        };
        (state $f:path, [ $($arg:ident : $ty:ty),+ ]) => {{
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args { $( $arg: $ty, )+ }
            match serde_json::from_value::<Args>(args) {
                Ok(a) => respond($f(app.db(), $( a.$arg ),+)),
                Err(e) => err(format!("invalid arguments for {cmd}: {e}")),
            }
        }};
        (app_state $f:path) => {
            respond($f(app.clone(), app.db()))
        };
        (app_state $f:path, [ $($arg:ident : $ty:ty),+ ]) => {{
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args { $( $arg: $ty, )+ }
            match serde_json::from_value::<Args>(args) {
                Ok(a) => respond($f(app.clone(), app.db(), $( a.$arg ),+)),
                Err(e) => err(format!("invalid arguments for {cmd}: {e}")),
            }
        }};
        (app_async $f:path) => {
            respond($f(app.clone()).await)
        };
        (app_async $f:path, [ $($arg:ident : $ty:ty),+ ]) => {{
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args { $( $arg: $ty, )+ }
            match serde_json::from_value::<Args>(args) {
                Ok(a) => respond($f(app.clone(), $( a.$arg ),+).await),
                Err(e) => err(format!("invalid arguments for {cmd}: {e}")),
            }
        }};
        (plain $v:expr) => {
            respond(Ok::<_, String>($v))
        };
    }

    match cmd.as_str() {
        "data_dir" => run!(plain crate::data_dir()),
        "data_dir_info" => run!(plain crate::backup::data_dir_info()),

        "create_account" => run!(app_state crate::accounts::create_account, [
            name: String, kind: Option<String>, bank: String, currency: String,
            account_number: Option<String>, owner_name: Option<String>]),
        "list_accounts" => run!(state crate::accounts::list_accounts),
        "update_account" => run!(state crate::accounts::update_account, [
            id: i64, name: String, kind: Option<String>, bank: String, currency: String,
            account_number: Option<String>, owner_name: Option<String>]),
        "delete_account" => run!(state crate::accounts::delete_account, [id: i64]),

        "account_monthly_status" => run!(state crate::account_status::account_monthly_status, [
            months: Vec<crate::account_status::MonthRange>]),
        "account_monthly_summary_stats" => {
            run!(state crate::account_status::account_monthly_summary_stats, [
                months: Vec<crate::account_status::MonthRange>])
        }

        "create_category" => run!(state crate::categories::create_category, [
            name: String, color: String, kind: String,
            parent_id: Option<i64>, description: Option<String>]),
        "list_categories" => run!(state crate::categories::list_categories),
        "update_category" => run!(state crate::categories::update_category, [
            id: i64, name: String, color: String,
            description: Option<String>, parent_id: Option<i64>]),
        "delete_category" => run!(state crate::categories::delete_category, [id: i64]),

        "list_currencies" => run!(state crate::currencies::list_currencies),

        "set_transaction_categories" => {
            run!(state crate::transaction_categories::set_transaction_categories, [
                transaction_id: i64, items: Vec<crate::transaction_categories::CategoryItem>])
        }
        "list_transactions_categories" => {
            run!(state crate::transaction_categories::list_transactions_categories, [
                account_ids: Option<Vec<i64>>])
        }

        "link_transactions" => run!(state crate::transaction_links::link_transactions, [
            a_id: i64, b_id: i64]),
        "unlink_transaction" => run!(state crate::transaction_links::unlink_transaction, [
            transaction_id: i64]),
        "list_transaction_links" => run!(state crate::transaction_links::list_transaction_links, [
            account_ids: Option<Vec<i64>>]),

        "list_transfer_deltas" => run!(state crate::transfer_deltas::list_transfer_deltas),

        "import_transactions" => run!(state crate::transactions::import_transactions, [
            account_id: i64, source_filename: Option<String>,
            default_timezone_offset: String, rows: Vec<crate::transactions::TxnImportRow>]),
        "list_transactions" => run!(state crate::transactions::list_transactions, [
            account_ids: Option<Vec<i64>>]),
        "first_transaction_date" => run!(state crate::transactions::first_transaction_date, [
            account_ids: Option<Vec<i64>>]),
        "latest_transactions" => run!(state crate::transactions::latest_transactions),
        "list_import_batches" => run!(state crate::transactions::list_import_batches, [
            account_id: i64]),
        "delete_import_batch" => run!(state crate::transactions::delete_import_batch, [
            batch_id: i64]),
        "validate_balance_chain" => run!(state crate::transactions::validate_balance_chain, [
            account_id: i64]),
        "validate_import_preview" => run!(state crate::transactions::validate_import_preview, [
            account_id: i64, default_timezone_offset: String,
            rows: Vec<crate::transactions::TxnImportRow>]),
        "update_transaction_comment" => {
            run!(state crate::transactions::update_transaction_comment, [
                id: i64, comment: Option<String>])
        }
        "bulk_update_transaction_fields" => {
            run!(state crate::transactions::bulk_update_transaction_fields, [
                account_id: i64, default_timezone_offset: String,
                rows: Vec<crate::transactions::TxnImportRow>])
        }
        "get_transaction" => run!(state crate::transactions::get_transaction, [id: i64]),
        "update_transaction_fields" => run!(state crate::transactions::update_transaction_fields, [
            id: i64, peer: Option<String>, bank_description: Option<String>,
            comment: Option<String>]),

        "create_cash_transaction" => run!(state crate::cash_transactions::create_cash_transaction, [
            account_id: i64, occurred_at_utc: String,
            direction: crate::cash_transactions::CashDirection, amount: String,
            peer: Option<String>, comment: Option<String>]),
        "update_cash_transaction" => run!(state crate::cash_transactions::update_cash_transaction, [
            id: i64, occurred_at_utc: String,
            direction: crate::cash_transactions::CashDirection, amount: String,
            peer: Option<String>, comment: Option<String>]),
        "delete_cash_transaction" => run!(state crate::cash_transactions::delete_cash_transaction, [
            id: i64]),
        "create_cash_withdrawal" => run!(state crate::cash_withdrawals::create_cash_withdrawal, [
            source_txn_id: i64, cash_account_id: i64, amount: String]),

        "get_setting" => run!(state crate::settings::get_setting, [key: String]),
        "set_setting" => run!(state crate::settings::set_setting, [key: String, value: String]),

        "ai_test_connection" => run!(app_async crate::ai::ai_test_connection),
        "ai_transaction_chat" => run!(app_async crate::ai::ai_transaction_chat, [
            transaction_id: i64, messages: Vec<crate::ai::ChatMsg>]),
        "set_transaction_agent" => run!(state crate::ai::set_transaction_agent, [
            transaction_id: i64, agent: Option<String>]),

        "list_exchange_rates" => run!(state crate::exchange_rates::list_exchange_rates),
        "upsert_exchange_rate" => run!(state crate::exchange_rates::upsert_exchange_rate, [
            currency: String, rate_date: String, rate_to_base: String]),
        "delete_exchange_rate" => run!(state crate::exchange_rates::delete_exchange_rate, [
            id: i64]),
        "download_rates_for_currency" => {
            run!(app_async crate::exchange_rates::download_rates_for_currency, [currency: String])
        }
        "list_currency_rate_summaries" => {
            run!(state crate::exchange_rates::list_currency_rate_summaries)
        }
        "list_rate_entries_for_currency" => {
            run!(state crate::exchange_rates::list_rate_entries_for_currency, [currency: String])
        }
        "convert_amount" => run!(state crate::exchange_rates::convert_amount, [
            amount: String, from_currency: String, to_currency: String,
            date_yyyy_mm_dd: String]),

        "list_report_views" => run!(state crate::report_views::list_report_views),
        "create_report_view" => run!(state crate::report_views::create_report_view, [
            name: String, config: String]),
        "update_report_view" => run!(state crate::report_views::update_report_view, [
            id: i64, name: String, config: String]),
        "delete_report_view" => run!(state crate::report_views::delete_report_view, [id: i64]),
        "reorder_report_views" => run!(state crate::report_views::reorder_report_views, [
            ids: Vec<i64>]),

        "compute_report" => run!(state crate::reports::compute_report, [
            request: crate::reports::ReportRequest]),
        "report_cell_transactions" => run!(state crate::reports::report_cell_transactions, [
            request: crate::reports::ReportRequest, target: crate::reports::CellTarget]),

        "seed_demo_data" => run!(app_state crate::seed::seed_demo_data),
        "clear_all_data" => run!(state crate::seed::clear_all_data),

        _ => (StatusCode::NOT_FOUND, format!("unknown command: {cmd}")).into_response(),
    }
}
