//! Desktop shell: runs the regular axum server (`a2b_accounting_lib::run`,
//! exactly what the Docker image runs) in a background thread on a loopback
//! port and shows it in a native window. The web UI and the backend are
//! shared with the Docker build; this crate only adds what a desktop app
//! needs on top — data/resource paths, an access token for the local port, a
//! DB copy before a new version migrates it, and self-update (`updater.rs`).

// No console window next to the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod updater;

use std::fs;
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// Fixed rather than random: the page origin (`http://127.0.0.1:<port>`)
/// must stay the same between launches, or the webview's per-origin storage
/// would start empty every time.
const PORT: u16 = 47390;
/// The server binds only after migrations, so a big DB upgrade counts here.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
const DB_FILENAME: &str = "finances.db";
/// Copies of the DB taken before a different app version first opens it.
const PRE_UPDATE_PREFIX: &str = "finances.db.pre-update-";
const KEEP_PRE_UPDATE_COPIES: usize = 10;
/// Last app version that opened the data dir.
const VERSION_MARKER: &str = "desktop-version";

pub const MAIN_WINDOW: &str = "main";

fn main() {
    let context = tauri::generate_context!();
    let version = context.package_info().version.to_string();
    let data_dir = dirs::data_dir()
        .expect("no per-user data directory")
        .join(&context.config().identifier);
    let resources =
        tauri::utils::platform::resource_dir(context.package_info(), &tauri::Env::default())
            .expect("cannot locate the app resources");
    let token = uuid::Uuid::new_v4().simple().to_string();

    // The server is configured through env vars (see server/src/lib.rs).
    // They are set here, before any other thread exists; values already in
    // the environment win, so a developer can point the shell elsewhere.
    set_default_env("FINANCES_DATA_DIR", &data_dir.to_string_lossy());
    set_default_env("FINANCES_STATIC_DIR", &resources.join("static").to_string_lossy());
    set_default_env("FINANCES_OCR_MODELS", &resources.join("ocr-models").to_string_lossy());
    set_default_env("FINANCES_OCR_DICTS", &resources.join("ocr-dicts").to_string_lossy());
    std::env::set_var("FINANCES_BIND", format!("127.0.0.1:{PORT}"));
    std::env::set_var("FINANCES_ACCESS_TOKEN", &token);

    let data_dir = std::path::PathBuf::from(std::env::var("FINANCES_DATA_DIR").unwrap());
    let startup = prepare(&data_dir, &version);
    let server = startup
        .is_ok()
        .then(|| std::thread::spawn(a2b_accounting_lib::run));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
            let handle = app.handle().clone();
            updater::install(&handle, &data_dir)?;
            std::thread::spawn(move || {
                let result = startup.and_then(|()| wait_for_server(server.unwrap()));
                match result {
                    Ok(()) => open_main_window(&handle, &token),
                    Err(message) => fail(&handle, &message),
                }
            });
            Ok(())
        })
        .run(context)
        .expect("error while running the application");
}

fn set_default_env(key: &str, value: &str) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, value);
    }
}

/// Everything that must happen before the server starts.
fn prepare(data_dir: &Path, version: &str) -> Result<(), String> {
    fs::create_dir_all(data_dir)
        .map_err(|e| format!("Cannot create {}: {e}", data_dir.display()))?;
    // Another copy of the app (or anything else) on our port would answer
    // the readiness probe in place of our server.
    TcpListener::bind(("127.0.0.1", PORT)).map_err(|e| {
        format!("Port {PORT} is busy — is A2B Accounting already running?\n\n{e}")
    })?;
    copy_db_before_version_change(data_dir, version)
        .map_err(|e| format!("Cannot back up the database before the update: {e}"))
}

/// The server applies DB migrations on start, and a new version may bring
/// some. Before a different version first opens the DB, keep a copy of it
/// as it was — the server is not running yet, so the files are consistent.
fn copy_db_before_version_change(data_dir: &Path, version: &str) -> std::io::Result<()> {
    let marker = data_dir.join(VERSION_MARKER);
    let previous = fs::read_to_string(&marker).ok();
    let previous = previous.as_deref().map(str::trim);
    let db = data_dir.join(DB_FILENAME);
    if previous.is_some_and(|p| p != version) && db.exists() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let copy = format!("{PRE_UPDATE_PREFIX}{}-{stamp}", previous.unwrap());
        fs::copy(&db, data_dir.join(&copy))?;
        // Committed transactions may still sit in the WAL; SQLite opens
        // `<name>-wal` next to the copy just as it does for the original.
        let wal = data_dir.join(format!("{DB_FILENAME}-wal"));
        if wal.exists() {
            fs::copy(&wal, data_dir.join(format!("{copy}-wal")))?;
        }
        prune_pre_update_copies(data_dir)?;
    }
    if previous != Some(version) {
        fs::write(&marker, version)?;
    }
    Ok(())
}

fn prune_pre_update_copies(data_dir: &Path) -> std::io::Result<()> {
    let mut copies: Vec<(SystemTime, String)> = fs::read_dir(data_dir)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !name.starts_with(PRE_UPDATE_PREFIX) || name.ends_with("-wal") {
                return None;
            }
            Some((entry.metadata().ok()?.modified().ok()?, name))
        })
        .collect();
    copies.sort();
    let excess = copies.len().saturating_sub(KEEP_PRE_UPDATE_COPIES);
    for (_, name) in &copies[..excess] {
        fs::remove_file(data_dir.join(name))?;
        let _ = fs::remove_file(data_dir.join(format!("{name}-wal")));
    }
    Ok(())
}

/// The server binds its port only after the DB is open and migrated, so an
/// accepted connection means it is ready.
fn wait_for_server(server: JoinHandle<()>) -> Result<(), String> {
    let started = Instant::now();
    loop {
        if server.is_finished() {
            let reason = match server.join() {
                Err(panic) => panic
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "unknown error".into()),
                Ok(()) => "the server stopped".into(),
            };
            return Err(format!("The app could not start.\n\n{reason}"));
        }
        if TcpStream::connect(("127.0.0.1", PORT)).is_ok() {
            return Ok(());
        }
        if started.elapsed() > STARTUP_TIMEOUT {
            return Err("The app did not start in time.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Built off the main thread on purpose: creating a window from the main
/// thread's event handlers can deadlock (Tauri docs).
fn open_main_window(app: &AppHandle, token: &str) {
    let url = format!("http://127.0.0.1:{PORT}/?access_token={token}")
        .parse()
        .expect("valid URL");
    let built = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(url))
        .title("A2B Accounting")
        .inner_size(1400.0, 900.0)
        .min_inner_size(1000.0, 650.0)
        .build();
    if let Err(e) = built {
        fail(app, &format!("Cannot open the window: {e}"));
    }
}

fn fail(app: &AppHandle, message: &str) {
    eprintln!("{message}");
    app.dialog()
        .message(message)
        .title("A2B Accounting")
        .kind(MessageDialogKind::Error)
        .blocking_show();
    app.exit(1);
}
