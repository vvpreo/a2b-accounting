mod account_status;
mod accounts;
mod ai;
mod backup;
mod cash_transactions;
mod cash_withdrawals;
mod categories;
mod currencies;
mod db;
mod exchange_rates;
mod frankfurter;
pub mod host;
mod http;
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
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::host::AppHandle;

const ENV_DATA_DIR: &str = "FINANCES_DATA_DIR";
const ENV_BIND: &str = "FINANCES_BIND";
const ENV_STATIC_DIR: &str = "FINANCES_STATIC_DIR";
/// Loopback by default: in dev the Vite server proxies to us, in Docker the
/// image overrides this with `0.0.0.0:8080` and the compose file decides
/// which host interface (if any) the port is published on.
const DEFAULT_BIND: &str = "127.0.0.1:3701";

/// Where the actual `finances.db` lives, *and* how we decided that. With the
/// web build the choice is static for the process lifetime: either the
/// `FINANCES_DATA_DIR` env var (Docker, dev) or a per-user default path.
pub struct DataDirContext {
    pub data_dir: PathBuf,
    pub source: DataDirSource,
}

#[derive(Clone, Copy)]
pub enum DataDirSource {
    /// No env var — we're on the platform-default path under `$HOME`.
    Default,
    /// `FINANCES_DATA_DIR` env var is set (the normal mode in Docker/dev).
    Env,
}

static DATA_DIR_CTX: OnceLock<DataDirContext> = OnceLock::new();

pub fn data_dir_context() -> &'static DataDirContext {
    DATA_DIR_CTX
        .get()
        .expect("data dir context not initialised — call resolve_data_dir during setup")
}

fn resolve_data_dir() -> DataDirContext {
    // Env override wins — it is the primary configuration mechanism for the
    // web build (compose sets FINANCES_DATA_DIR=/data, dev uses .envrc).
    if let Ok(value) = std::env::var(ENV_DATA_DIR) {
        if !value.is_empty() {
            let path = PathBuf::from(value);
            if let Err(e) = fs::create_dir_all(&path) {
                panic!("failed to create FINANCES_DATA_DIR {}: {e}", path.display());
            }
            return DataDirContext {
                data_dir: path,
                source: DataDirSource::Env,
            };
        }
    }

    let home = std::env::var("HOME")
        .expect("neither FINANCES_DATA_DIR nor HOME is set — cannot locate a data directory");
    let path = PathBuf::from(home).join(".local/share/net.vvpreo.finances");
    if let Err(e) = fs::create_dir_all(&path) {
        panic!("failed to create default data dir {}: {e}", path.display());
    }
    DataDirContext {
        data_dir: path,
        source: DataDirSource::Default,
    }
}

pub fn data_dir() -> String {
    data_dir_context().data_dir.to_string_lossy().into_owned()
}

/// Open the DB in `dir` and run every idempotent startup fixup (first-launch
/// demo seed, default report view, AI provider config). Used both at process
/// start and after a backup restore replaces the DB file.
pub fn open_and_init(dir: &Path) -> Result<rusqlite::Connection, String> {
    let conn = db::open(dir).map_err(|e| format!("failed to open database: {e}"))?;
    seed::seed_if_first_launch(&conn).map_err(|e| format!("failed to seed demo data: {e}"))?;
    seed::ensure_default_report_view(&conn)
        .map_err(|e| format!("failed to ensure accounting report: {e}"))?;
    seed::ensure_ai_provider_config(&conn)
        .map_err(|e| format!("failed to ensure ai provider config: {e}"))?;
    Ok(conn)
}

pub fn run() {
    let ctx = resolve_data_dir();
    let conn = open_and_init(&ctx.data_dir)
        .unwrap_or_else(|e| panic!("startup failed in {}: {e}", ctx.data_dir.display()));
    DATA_DIR_CTX
        .set(ctx)
        .ok()
        .expect("data dir context already initialised");

    let app = AppHandle::new(Mutex::new(conn));

    let runtime = tokio::runtime::Runtime::new().expect("failed to start tokio runtime");
    runtime.block_on(async {
        // Background rate fetches for any currency that has accounts but no
        // rates yet (covers both first-launch demo seeding and pre-existing
        // user data that pre-dates this feature).
        if let Err(err) = exchange_rates::spawn_missing_rate_downloads(app.clone()) {
            eprintln!("startup rate prefill failed: {err}");
        }
        http::serve(app).await;
    });
}
