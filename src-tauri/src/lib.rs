mod account_status;
mod accounts;
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

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use tauri::Manager;

const ENV_DATA_DIR: &str = "FINANCES_DATA_DIR";

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

fn resolve_data_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    let path = match std::env::var(ENV_DATA_DIR) {
        Ok(value) if !value.is_empty() => PathBuf::from(value),
        _ => app_handle
            .path()
            .app_data_dir()
            .expect("failed to resolve platform app data dir"),
    };
    std::fs::create_dir_all(&path).unwrap_or_else(|e| {
        panic!("failed to create data directory {}: {e}", path.display());
    });
    path
}

#[tauri::command]
fn data_dir() -> String {
    DATA_DIR
        .get()
        .expect("data dir not initialized")
        .to_string_lossy()
        .into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let dir = resolve_data_dir(app.handle());
            let conn = db::open(&dir).unwrap_or_else(|e| {
                panic!("failed to open database in {}: {e}", dir.display());
            });
            seed::seed_if_first_launch(&conn).unwrap_or_else(|e| {
                panic!("failed to seed demo data: {e}");
            });
            seed::ensure_default_report_view(&conn).unwrap_or_else(|e| {
                panic!("failed to ensure accounting report: {e}");
            });
            app.manage::<db::DbState>(Mutex::new(conn));
            DATA_DIR.set(dir).expect("data dir already initialized");
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
            transactions::import_transactions,
            transactions::list_transactions,
            transactions::first_transaction_date,
            transactions::latest_transactions,
            transactions::list_import_batches,
            transactions::delete_import_batch,
            transactions::validate_balance_chain,
            transactions::validate_import_preview,
            transactions::update_transaction_comment,
            settings::get_setting,
            settings::set_setting,
            exchange_rates::list_exchange_rates,
            exchange_rates::upsert_exchange_rate,
            exchange_rates::delete_exchange_rate,
            exchange_rates::download_rates_for_currency,
            exchange_rates::list_currency_rate_summaries,
            exchange_rates::list_rate_entries_for_currency,
            report_views::list_report_views,
            report_views::create_report_view,
            report_views::update_report_view,
            report_views::delete_report_view,
            report_views::reorder_report_views,
            reports::compute_report,
            seed::seed_demo_data,
            seed::clear_all_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
