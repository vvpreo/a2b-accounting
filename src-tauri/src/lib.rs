mod accounts;
mod categories;
mod db;
mod money;
mod settings;
mod transaction_categories;
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
            app.manage::<db::DbState>(Mutex::new(conn));
            DATA_DIR.set(dir).expect("data dir already initialized");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            data_dir,
            accounts::create_account,
            accounts::list_accounts,
            accounts::update_account,
            accounts::delete_account,
            categories::create_category,
            categories::list_categories,
            categories::update_category,
            categories::delete_category,
            transaction_categories::set_transaction_categories,
            transaction_categories::list_transactions_categories,
            transactions::import_transactions,
            transactions::list_transactions,
            transactions::list_import_batches,
            transactions::delete_import_batch,
            transactions::validate_balance_chain,
            transactions::validate_import_preview,
            transactions::update_transaction_comment,
            settings::get_setting,
            settings::set_setting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
