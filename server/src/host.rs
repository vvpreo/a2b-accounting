//! Minimal runtime context shared by every command handler. This module
//! replaces the Tauri primitives the commands used to depend on (`State`,
//! `AppHandle`, event emission) with plain equivalents backed by the HTTP
//! server, so the command modules themselves stay unchanged.

use std::sync::Arc;

use serde::Serialize;
use tokio::sync::broadcast;

use crate::db::DbState;

/// Borrowed handle to shared state. Mirrors the shape of `tauri::State` so
/// command signatures did not have to change in the desktop→web port.
pub type State<'a, T> = &'a T;

pub struct AppInner {
    pub db: DbState,
    /// Fan-out bus for backend→frontend events, delivered to browsers via
    /// `GET /api/events` (SSE). Messages are pre-wrapped `{event, payload}`
    /// JSON objects.
    pub events: broadcast::Sender<serde_json::Value>,
}

/// Cheaply-clonable handle to the app-wide shared state. The name is kept
/// from the Tauri days on purpose — commands that spawn background work or
/// emit events take an `AppHandle` exactly like they used to.
#[derive(Clone)]
pub struct AppHandle(pub Arc<AppInner>);

impl AppHandle {
    pub fn new(db: DbState) -> Self {
        // Capacity is per-subscriber buffering; slow SSE consumers that fall
        // more than 64 events behind just skip the missed ones.
        let (tx, _) = broadcast::channel(64);
        AppHandle(Arc::new(AppInner { db, events: tx }))
    }

    pub fn db(&self) -> &DbState {
        &self.0.db
    }

    /// Broadcast an event to all connected SSE clients. A send error only
    /// means nobody is listening — that is not a failure.
    pub fn emit<P: Serialize>(&self, event: &str, payload: P) -> Result<(), String> {
        let msg = serde_json::json!({ "event": event, "payload": payload });
        let _ = self.0.events.send(msg);
        Ok(())
    }
}
