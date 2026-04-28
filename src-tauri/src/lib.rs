mod accounts;
mod db;
mod money;
mod settings;
mod transactions;

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const ENV_DATA_DIR: &str = "FINANCES_DATA_DIR";

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

fn init_data_dir() -> PathBuf {
    let raw = std::env::var(ENV_DATA_DIR).unwrap_or_else(|_| {
        panic!("environment variable {ENV_DATA_DIR} is not set");
    });
    let path = PathBuf::from(&raw);
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
    let dir = init_data_dir();
    let conn = db::open(&dir).unwrap_or_else(|e| {
        panic!("failed to open database in {}: {e}", dir.display());
    });
    DATA_DIR.set(dir).expect("data dir already initialized");

    tauri::Builder::default()
        .manage::<db::DbState>(Mutex::new(conn))
        .invoke_handler(tauri::generate_handler![
            data_dir,
            accounts::create_account,
            accounts::list_accounts,
            accounts::update_account,
            accounts::delete_account,
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
