use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbState;
use crate::money;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnImportRow {
    pub occurred_at: String,
    pub peer: String,
    pub credit: String,
    pub debit: String,
    pub balance: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: i64,
    pub account_id: i64,
    pub import_batch_id: i64,
    pub occurred_at_utc: String,
    pub peer: String,
    pub credit: String,
    pub debit: String,
    pub balance: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBatch {
    pub id: i64,
    pub account_id: i64,
    pub imported_at: String,
    pub source_filename: Option<String>,
    pub row_count: i64,
    pub timezone_offset: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationError {
    pub txn_id: i64,
    pub expected_balance: String,
    pub actual_balance: String,
    pub occurred_at_utc: String,
    pub description: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub batch_id: i64,
    pub inserted: i64,
    pub validation_errors: Vec<ValidationError>,
}

struct ParsedRow {
    occurred_at_utc: String,
    occurred_at_tz: String,
    peer: String,
    credit: i64,
    debit: i64,
    balance: i64,
    description: String,
}

fn parse_amount_or_zero(s: &str) -> Result<i64, String> {
    if s.trim().is_empty() {
        Ok(0)
    } else {
        money::parse_minor(s).map_err(|e| e.to_string())
    }
}

fn parse_datetime(s: &str) -> Result<(String, String), String> {
    let dt = DateTime::parse_from_rfc3339(s.trim())
        .map_err(|e| format!("invalid datetime '{s}': {e}"))?;
    let utc = dt.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true);
    let offset = dt.offset().to_string();
    Ok((utc, offset))
}

fn parse_row(r: &TxnImportRow) -> Result<ParsedRow, String> {
    let (occurred_at_utc, occurred_at_tz) = parse_datetime(&r.occurred_at)?;
    let credit = parse_amount_or_zero(&r.credit)?;
    let debit = parse_amount_or_zero(&r.debit)?;
    if credit < 0 || debit < 0 {
        return Err("credit and debit must be non-negative".to_string());
    }
    if credit != 0 && debit != 0 {
        return Err("row has both credit and debit; only one is allowed".to_string());
    }
    let balance = money::parse_minor(&r.balance).map_err(|e| e.to_string())?;
    Ok(ParsedRow {
        occurred_at_utc,
        occurred_at_tz,
        peer: r.peer.clone(),
        credit,
        debit,
        balance,
        description: r.description.clone(),
    })
}

fn txn_from_row(row: &Row) -> rusqlite::Result<Transaction> {
    let credit: i64 = row.get(4)?;
    let debit: i64 = row.get(5)?;
    let balance: i64 = row.get(6)?;
    Ok(Transaction {
        id: row.get(0)?,
        account_id: row.get(1)?,
        import_batch_id: row.get(2)?,
        occurred_at_utc: row.get(3)?,
        credit: money::format_minor(credit),
        debit: money::format_minor(debit),
        balance: money::format_minor(balance),
        description: row.get(7)?,
        peer: row.get(8)?,
    })
}

const TXN_COLUMNS: &str =
    "id, account_id, import_batch_id, occurred_at_utc, credit, debit, balance, description, peer";

fn batch_from_row(row: &Row) -> rusqlite::Result<ImportBatch> {
    Ok(ImportBatch {
        id: row.get(0)?,
        account_id: row.get(1)?,
        imported_at: row.get(2)?,
        source_filename: row.get(3)?,
        row_count: row.get(4)?,
        timezone_offset: row.get(5)?,
    })
}

#[tauri::command]
pub fn import_transactions(
    state: State<'_, DbState>,
    account_id: i64,
    source_filename: Option<String>,
    rows: Vec<TxnImportRow>,
) -> Result<ImportResult, String> {
    if rows.is_empty() {
        return Err("no rows to import".to_string());
    }

    let parsed: Vec<ParsedRow> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| parse_row(r).map_err(|e| format!("row {}: {e}", i + 1)))
        .collect::<Result<_, _>>()?;

    let timezone_offset = parsed[0].occurred_at_tz.clone();
    if let Some((idx, mismatched)) = parsed
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, p)| p.occurred_at_tz != timezone_offset)
    {
        return Err(format!(
            "row {}: timezone offset '{}' differs from batch offset '{}'; \
             all rows in one import must share the same offset",
            idx + 1,
            mismatched.occurred_at_tz,
            timezone_offset
        ));
    }

    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let conn: &mut Connection = &mut guard;

    let account_exists: bool = conn
        .query_row(
            "SELECT 1 FROM accounts WHERE id = ?1",
            [account_id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !account_exists {
        return Err(format!("account {account_id} does not exist"));
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let imported_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let row_count = parsed.len() as i64;

    let batch_id: i64 = tx
        .query_row(
            "INSERT INTO import_batches (account_id, imported_at, source_filename, row_count, timezone_offset)
             VALUES (?1, ?2, ?3, ?4, ?5)
             RETURNING id",
            params![account_id, imported_at, source_filename, row_count, timezone_offset],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO transactions (
                    account_id, import_batch_id,
                    occurred_at_utc,
                    peer, credit, debit, balance, description
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| e.to_string())?;
        for p in &parsed {
            stmt.execute(params![
                account_id,
                batch_id,
                p.occurred_at_utc,
                p.peer,
                p.credit,
                p.debit,
                p.balance,
                p.description,
            ])
            .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    let validation_errors =
        validate_account_chain(conn, account_id).map_err(|e| e.to_string())?;

    Ok(ImportResult {
        batch_id,
        inserted: row_count,
        validation_errors,
    })
}

#[tauri::command]
pub fn list_transactions(
    state: State<'_, DbState>,
    account_id: i64,
) -> Result<Vec<Transaction>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TXN_COLUMNS} FROM transactions
             WHERE account_id = ?1
             ORDER BY occurred_at_utc ASC, id ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([account_id], txn_from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_import_batches(
    state: State<'_, DbState>,
    account_id: i64,
) -> Result<Vec<ImportBatch>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, imported_at, source_filename, row_count, timezone_offset
             FROM import_batches
             WHERE account_id = ?1
             ORDER BY imported_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([account_id], batch_from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_import_batch(
    state: State<'_, DbState>,
    batch_id: i64,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let deleted = conn
        .execute("DELETE FROM import_batches WHERE id = ?1", [batch_id])
        .map_err(|e| e.to_string())?;
    if deleted == 0 {
        return Err(format!("import batch {batch_id} does not exist"));
    }
    Ok(())
}

#[tauri::command]
pub fn validate_balance_chain(
    state: State<'_, DbState>,
    account_id: i64,
) -> Result<Vec<ValidationError>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    validate_account_chain(&conn, account_id).map_err(|e| e.to_string())
}

struct ChainRow {
    id: i64,
    occurred_at_utc: String,
    credit: i64,
    debit: i64,
    balance: i64,
    description: String,
}

fn validate_account_chain(
    conn: &Connection,
    account_id: i64,
) -> rusqlite::Result<Vec<ValidationError>> {
    let mut stmt = conn.prepare(
        "SELECT id, occurred_at_utc, credit, debit, balance, description
         FROM transactions
         WHERE account_id = ?1
         ORDER BY occurred_at_utc ASC, id ASC",
    )?;

    let txns: Vec<ChainRow> = stmt
        .query_map([account_id], |r| {
            Ok(ChainRow {
                id: r.get(0)?,
                occurred_at_utc: r.get(1)?,
                credit: r.get(2)?,
                debit: r.get(3)?,
                balance: r.get(4)?,
                description: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    Ok(check_chain(&txns))
}

fn check_chain(txns: &[ChainRow]) -> Vec<ValidationError> {
    let mut errors = Vec::new();
    for i in 1..txns.len() {
        let prev = &txns[i - 1];
        let curr = &txns[i];
        let expected = prev.balance + curr.credit - curr.debit;
        if expected != curr.balance {
            errors.push(ValidationError {
                txn_id: curr.id,
                expected_balance: money::format_minor(expected),
                actual_balance: money::format_minor(curr.balance),
                occurred_at_utc: curr.occurred_at_utc.clone(),
                description: curr.description.clone(),
            });
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, credit: i64, debit: i64, balance: i64) -> ChainRow {
        ChainRow {
            id,
            occurred_at_utc: format!("2026-04-01T00:00:0{id}Z"),
            credit,
            debit,
            balance,
            description: format!("txn {id}"),
        }
    }

    #[test]
    fn empty_chain_has_no_errors() {
        assert!(check_chain(&[]).is_empty());
    }

    #[test]
    fn single_txn_always_valid() {
        assert!(check_chain(&[row(1, 0, 500, 10000)]).is_empty());
    }

    #[test]
    fn valid_chain() {
        let txns = vec![
            row(1, 0, 500, 10000),    // starts here
            row(2, 1000, 0, 11000),   // +1000
            row(3, 0, 200, 10800),    // -200
        ];
        assert!(check_chain(&txns).is_empty());
    }

    #[test]
    fn detects_gap_in_middle() {
        let txns = vec![
            row(1, 0, 500, 10000),
            row(2, 1000, 0, 12000), // expected 11000
            row(3, 0, 200, 11800),  // consistent relative to prev
        ];
        let errors = check_chain(&txns);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].txn_id, 2);
        assert_eq!(errors[0].expected_balance, "110.00");
        assert_eq!(errors[0].actual_balance, "120.00");
    }
}
