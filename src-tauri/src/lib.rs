mod account_status;
mod accounts;
mod backup;
mod cash_transactions;
mod cash_withdrawals;
mod categories;
mod currencies;
mod db;
mod exchange_rates;
mod frankfurter;
mod money;
mod report_views;
mod reports;
mod seed;
mod settings;
mod transaction_categories;
mod transaction_links;
mod transactions;
mod transfer_deltas;

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use tauri::Manager;

const ENV_DATA_DIR: &str = "FINANCES_DATA_DIR";
const DATA_DIR_POINTER_FILE: &str = "data-dir.txt";

/// Where the actual `finances.db` lives, *and* how we decided that. The
/// platform-default appdata path travels alongside — even when the user
/// has redirected storage to a custom location, the pointer file that
/// records that choice still lives in the canonical appdata directory so
/// the next launch can find it.
pub struct DataDirContext {
    pub appdata_default: PathBuf,
    pub data_dir: PathBuf,
    pub source: DataDirSource,
}

#[derive(Clone, Copy)]
pub enum DataDirSource {
    /// No env var, no pointer file — we're on the platform-default path.
    Default,
    /// `FINANCES_DATA_DIR` env var is set. UI must not let the user
    /// switch the directory in this mode (would be silently ignored).
    Env,
    /// Pointer file in the platform-default appdata dir redirects us
    /// elsewhere. UI can change this freely.
    Pointer,
}

static DATA_DIR_CTX: OnceLock<DataDirContext> = OnceLock::new();

pub fn data_dir_context() -> &'static DataDirContext {
    DATA_DIR_CTX
        .get()
        .expect("data dir context not initialised — call resolve_data_dir during setup")
}

fn resolve_data_dir(app_handle: &tauri::AppHandle) -> DataDirContext {
    // The platform-default path is what `path().app_data_dir()` returns —
    // typically `~/Library/Application Support/<bundle id>/` on macOS. We
    // need it regardless of which mode we end up in because the pointer
    // file always lives here.
    let appdata_default = app_handle
        .path()
        .app_data_dir()
        .expect("failed to resolve platform app data dir");
    if let Err(e) = fs::create_dir_all(&appdata_default) {
        panic!(
            "failed to create platform appdata dir {}: {e}",
            appdata_default.display()
        );
    }

    // Env override wins — used in dev (via .envrc) and as a last-ditch
    // escape hatch for production. We never touch the pointer file in
    // this mode; the env var is purely runtime.
    if let Ok(value) = std::env::var(ENV_DATA_DIR) {
        if !value.is_empty() {
            let path = PathBuf::from(value);
            if let Err(e) = fs::create_dir_all(&path) {
                panic!("failed to create FINANCES_DATA_DIR {}: {e}", path.display());
            }
            return DataDirContext {
                appdata_default,
                data_dir: path,
                source: DataDirSource::Env,
            };
        }
    }

    // Pointer file: a single line containing the absolute path to the
    // data dir. Empty / missing / malformed → fall back to default.
    let pointer = appdata_default.join(DATA_DIR_POINTER_FILE);
    if let Ok(s) = fs::read_to_string(&pointer) {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            // We try to create the directory — if the user moved the
            // external drive away we don't want to crash, just log and
            // fall back to default so the app still launches.
            if fs::create_dir_all(&path).is_ok() {
                return DataDirContext {
                    appdata_default,
                    data_dir: path,
                    source: DataDirSource::Pointer,
                };
            } else {
                eprintln!(
                    "data-dir pointer points at unreachable path {} — falling back to default",
                    path.display()
                );
            }
        }
    }

    DataDirContext {
        appdata_default: appdata_default.clone(),
        data_dir: appdata_default,
        source: DataDirSource::Default,
    }
}

#[tauri::command]
fn data_dir() -> String {
    data_dir_context().data_dir.to_string_lossy().into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let ctx = resolve_data_dir(app.handle());
            let conn = db::open(&ctx.data_dir).unwrap_or_else(|e| {
                panic!("failed to open database in {}: {e}", ctx.data_dir.display());
            });
            seed::seed_if_first_launch(&conn).unwrap_or_else(|e| {
                panic!("failed to seed demo data: {e}");
            });
            seed::ensure_default_report_view(&conn).unwrap_or_else(|e| {
                panic!("failed to ensure accounting report: {e}");
            });
            app.manage::<db::DbState>(Mutex::new(conn));
            DATA_DIR_CTX
                .set(ctx)
                .ok()
                .expect("data dir context already initialised");
            // After managed state is in place: spawn background rate fetches
            // for any currency that has accounts but no rates yet (covers both
            // first-launch demo seeding and pre-existing user data that
            // pre-dates this feature).
            if let Err(err) = exchange_rates::spawn_missing_rate_downloads(app.handle().clone()) {
                eprintln!("startup rate prefill failed: {err}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            data_dir,
            backup::data_dir_info,
            backup::set_data_dir,
            backup::reset_data_dir,
            backup::backup_to_zip,
            backup::restore_from_zip,
            backup::restart_app,
            accounts::create_account,
            accounts::list_accounts,
            accounts::update_account,
            accounts::delete_account,
            account_status::account_monthly_status,
            account_status::account_monthly_summary_stats,
            categories::create_category,
            categories::list_categories,
            categories::update_category,
            categories::delete_category,
            currencies::list_currencies,
            transaction_categories::set_transaction_categories,
            transaction_categories::list_transactions_categories,
            transaction_links::link_transactions,
            transaction_links::unlink_transaction,
            transaction_links::list_transaction_links,
            transfer_deltas::list_transfer_deltas,
            transactions::import_transactions,
            transactions::list_transactions,
            transactions::first_transaction_date,
            transactions::latest_transactions,
            transactions::list_import_batches,
            transactions::delete_import_batch,
            transactions::validate_balance_chain,
            transactions::validate_import_preview,
            transactions::update_transaction_comment,
            cash_transactions::create_cash_transaction,
            cash_transactions::update_cash_transaction,
            cash_transactions::delete_cash_transaction,
            cash_withdrawals::create_cash_withdrawal,
            settings::get_setting,
            settings::set_setting,
            exchange_rates::list_exchange_rates,
            exchange_rates::upsert_exchange_rate,
            exchange_rates::delete_exchange_rate,
            exchange_rates::download_rates_for_currency,
            exchange_rates::list_currency_rate_summaries,
            exchange_rates::list_rate_entries_for_currency,
            exchange_rates::convert_amount,
            report_views::list_report_views,
            report_views::create_report_view,
            report_views::update_report_view,
            report_views::delete_report_view,
            report_views::reorder_report_views,
            reports::compute_report,
            reports::report_cell_transactions,
            seed::seed_demo_data,
            seed::clear_all_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
