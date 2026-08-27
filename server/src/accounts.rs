use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use crate::host::{AppHandle, State};

use crate::db::DbState;
use crate::exchange_rates;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub bank: String,
    pub currency: String,
    pub account_number: Option<String>,
    pub owner_name: Option<String>,
    pub created_at: String,
}

fn from_row(row: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        bank: row.get(3)?,
        currency: row.get(4)?,
        account_number: row.get(5)?,
        owner_name: row.get(6)?,
        created_at: row.get(7)?,
    })
}

const SELECT_COLUMNS: &str =
    "id, name, kind, bank, currency, account_number, owner_name, created_at";

/// Normalise empty strings from the frontend to NULL so the partial unique
/// index on (bank, account_number) sees a real "no value" instead of an
/// empty string (which would collide across multiple cash accounts).
fn blank_to_none(value: Option<String>) -> Option<String> {
    value.and_then(|v| if v.trim().is_empty() { None } else { Some(v) })
}

fn normalise_kind(kind: Option<String>) -> Result<String, String> {
    let k = kind.unwrap_or_else(|| "bank".to_string());
    match k.as_str() {
        "bank" | "cash" => Ok(k),
        other => Err(format!("invalid account kind: {other}")),
    }
}

pub fn create_account(
    app: AppHandle,
    state: State<'_, DbState>,
    name: String,
    kind: Option<String>,
    bank: String,
    currency: String,
    account_number: Option<String>,
    owner_name: Option<String>,
) -> Result<Account, String> {
    let kind = normalise_kind(kind)?;
    let account_number = blank_to_none(account_number);
    let owner_name = blank_to_none(owner_name);

    let (account, should_fetch_rates) = {
        let conn = state.lock().map_err(|e| e.to_string())?;

        let id: i64 = conn
            .query_row(
                "INSERT INTO accounts (name, kind, bank, currency, account_number, owner_name)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 RETURNING id",
                params![name, kind, bank, currency, account_number, owner_name],
                |row| row.get(0),
            )
            .map_err(|e| match &e {
                rusqlite::Error::SqliteFailure(err, _)
                    if err.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    let acct = account_number.as_deref().unwrap_or("");
                    format!(
                        "Account with bank '{bank}' and number '{acct}' already exists"
                    )
                }
                _ => e.to_string(),
            })?;

        let account = conn
            .query_row(
                &format!("SELECT {SELECT_COLUMNS} FROM accounts WHERE id = ?1"),
                [id],
                from_row,
            )
            .map_err(|e| e.to_string())?;

        // First account in this currency? (We just inserted, so 1 means first.)
        // Also require that no rates have been downloaded yet for this currency —
        // avoids re-downloading when the user removes all accounts in a currency
        // and then creates one again.
        let account_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM accounts WHERE currency = ?1",
                params![&account.currency],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let rate_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM exchange_rates WHERE currency = ?1",
                params![&account.currency],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;

        let should_fetch = account_count == 1
            && rate_count == 0
            && !account.currency.eq_ignore_ascii_case("EUR");
        (account, should_fetch)
    }; // db lock released here

    if should_fetch_rates {
        let app_clone = app.clone();
        let cur = account.currency.clone();
        tokio::spawn(async move {
            if let Err(err) =
                exchange_rates::download_rates_for_currency_internal(app_clone, cur.clone()).await
            {
                eprintln!("rate download for {cur} failed: {err}");
            }
        });
    }

    Ok(account)
}

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

pub fn update_account(
    state: State<'_, DbState>,
    id: i64,
    name: String,
    kind: Option<String>,
    bank: String,
    currency: String,
    account_number: Option<String>,
    owner_name: Option<String>,
) -> Result<Account, String> {
    let kind = normalise_kind(kind)?;
    let account_number = blank_to_none(account_number);
    let owner_name = blank_to_none(owner_name);

    let conn = state.lock().map_err(|e| e.to_string())?;

    let updated = conn
        .execute(
            "UPDATE accounts
             SET name = ?1, kind = ?2, bank = ?3, currency = ?4,
                 account_number = ?5, owner_name = ?6
             WHERE id = ?7",
            params![name, kind, bank, currency, account_number, owner_name, id],
        )
        .map_err(|e| match &e {
            rusqlite::Error::SqliteFailure(err, _)
                if err.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                let acct = account_number.as_deref().unwrap_or("");
                format!(
                    "Account with bank '{bank}' and number '{acct}' already exists"
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
