use std::path::PathBuf;
use std::sync::OnceLock;

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
    DATA_DIR
        .set(init_data_dir())
        .expect("data dir already initialized");

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![data_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
