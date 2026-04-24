use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    pub name: String,
    pub bank: String,
    pub currency: String,
    pub account_number: String,
    pub owner_name: String,
    pub created_at: String,
}

fn from_row(row: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: row.get(0)?,
        name: row.get(1)?,
        bank: row.get(2)?,
        currency: row.get(3)?,
        account_number: row.get(4)?,
        owner_name: row.get(5)?,
        created_at: row.get(6)?,
    })
}

const SELECT_COLUMNS: &str =
    "id, name, bank, currency, account_number, owner_name, created_at";

#[tauri::command]
pub fn create_account(
    state: State<'_, DbState>,
    name: String,
    bank: String,
    currency: String,
    account_number: String,
    owner_name: String,
) -> Result<Account, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;

    let id: i64 = conn
        .query_row(
            "INSERT INTO accounts (name, bank, currency, account_number, owner_name)
             VALUES (?1, ?2, ?3, ?4, ?5)
             RETURNING id",
            params![name, bank, currency, account_number, owner_name],
            |row| row.get(0),
        )
        .map_err(|e| match &e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                format!(
                    "Account with bank '{bank}' and number '{account_number}' already exists"
                )
            }
            _ => e.to_string(),
        })?;

    conn.query_row(
        &format!("SELECT {SELECT_COLUMNS} FROM accounts WHERE id = ?1"),
        [id],
        from_row,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_accounts(state: State<'_, DbState>) -> Result<Vec<Account>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(&format!(
            "SELECT {SELECT_COLUMNS} FROM accounts ORDER BY id ASC"
        ))
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], from_row)
        .map_err(|e| e.to_string())?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_account(
    state: State<'_, DbState>,
    id: i64,
    name: String,
    bank: String,
    currency: String,
    account_number: String,
    owner_name: String,
) -> Result<Account, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;

    let updated = conn
        .execute(
            "UPDATE accounts
             SET name = ?1, bank = ?2, currency = ?3, account_number = ?4, owner_name = ?5
             WHERE id = ?6",
            params![name, bank, currency, account_number, owner_name, id],
        )
        .map_err(|e| match &e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                format!(
                    "Account with bank '{bank}' and number '{account_number}' already exists"
                )
            }
            _ => e.to_string(),
        })?;

    if updated == 0 {
        return Err(format!("account {id} does not exist"));
    }

    conn.query_row(
        &format!("SELECT {SELECT_COLUMNS} FROM accounts WHERE id = ?1"),
        [id],
        from_row,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_account(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let deleted = conn
        .execute("DELETE FROM accounts WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    if deleted == 0 {
        return Err(format!("account {id} does not exist"));
    }
    Ok(())
}
