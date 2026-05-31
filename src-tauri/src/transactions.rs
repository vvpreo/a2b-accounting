use std::collections::{HashMap, HashSet};

use chrono::{DateTime, FixedOffset, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DbState;
use crate::money;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxnImportRow {
    pub occurred_at: String,
    pub credit: String,
    pub debit: String,
    pub balance: String,
    pub peer: Option<String>,
    pub bank_description: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transaction {
    pub id: i64,
    pub account_id: i64,
    /// `None` for manually-entered cash transactions (no import batch).
    pub import_batch_id: Option<i64>,
    pub occurred_at_utc: String,
    pub credit: String,
    pub debit: String,
    pub balance: String,
    pub peer: Option<String>,
    pub bank_description: Option<String>,
    pub comment: Option<String>,
    pub is_correcting: bool,
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
    pub bank_description: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub batch_id: i64,
    pub inserted: i64,
    pub corrections_inserted: i64,
    pub validation_errors: Vec<ValidationError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRowIssue {
    pub row_index: usize,
    pub kind: String,
    pub expected_balance: Option<String>,
    pub actual_balance: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewValidation {
    pub row_issues: Vec<PreviewRowIssue>,
}

#[derive(Debug)]
struct ParsedRow {
    occurred_at_utc: String,
    occurred_at_tz: String,
    credit: i64,
    debit: i64,
    balance: i64,
    peer: Option<String>,
    bank_description: Option<String>,
    comment: Option<String>,
    is_correcting: bool,
}

fn parse_amount_or_zero(s: &str) -> Result<i64, String> {
    if s.trim().is_empty() {
        Ok(0)
    } else {
        money::parse_minor(s).map_err(|e| e.to_string())
    }
}

fn parse_offset_str(s: &str) -> Result<FixedOffset, String> {
    let probe = format!("2000-01-01T00:00:00{}", s.trim());
    DateTime::parse_from_rfc3339(&probe)
        .map(|dt| *dt.offset())
        .map_err(|e| format!("invalid offset '{s}': {e}"))
}

const NAIVE_FORMATS: &[&str] = &[
    "%Y-%m-%dT%H:%M:%S%.f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S%.f",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M",
];

fn parse_datetime(s: &str, default_offset: &FixedOffset) -> Result<(String, String), String> {
    let trimmed = s.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
        let utc = dt.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true);
        return Ok((utc, dt.offset().to_string()));
    }
    for fmt in NAIVE_FORMATS {
        if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, fmt) {
            let dt = default_offset
                .from_local_datetime(&naive)
                .single()
                .ok_or_else(|| format!("ambiguous local datetime '{trimmed}'"))?;
            let utc = dt.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true);
            return Ok((utc, default_offset.to_string()));
        }
    }
    Err(format!("invalid datetime '{trimmed}'"))
}

fn normalize_optional(s: &Option<String>) -> Option<String> {
    s.as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn parse_row(r: &TxnImportRow, default_offset: &FixedOffset) -> Result<ParsedRow, String> {
    let (occurred_at_utc, occurred_at_tz) = parse_datetime(&r.occurred_at, default_offset)?;
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
        credit,
        debit,
        balance,
        peer: normalize_optional(&r.peer),
        bank_description: normalize_optional(&r.bank_description),
        comment: normalize_optional(&r.comment),
        is_correcting: false,
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
        peer: row.get(7)?,
        bank_description: row.get(8)?,
        comment: row.get(9)?,
        is_correcting: row.get(10)?,
    })
}

const TXN_COLUMNS: &str =
    "id, account_id, import_batch_id, occurred_at_utc, credit, debit, balance, peer, bank_description, comment, is_correcting";

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
    default_timezone_offset: String,
    rows: Vec<TxnImportRow>,
) -> Result<ImportResult, String> {
    if rows.is_empty() {
        return Err("no rows to import".to_string());
    }

    let default_offset = parse_offset_str(&default_timezone_offset)?;
    let parsed: Vec<ParsedRow> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            parse_row(r, &default_offset).map_err(|e| format!("row {}: {e}", i + 1))
        })
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

    let corrections =
        synthesize_corrections(conn, account_id, &parsed, &timezone_offset)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let imported_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let row_count = (parsed.len() + corrections.len()) as i64;

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
                    credit, debit, balance,
                    peer, bank_description, comment,
                    is_correcting
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )
            .map_err(|e| e.to_string())?;
        for p in parsed.iter().chain(corrections.iter()) {
            stmt.execute(params![
                account_id,
                batch_id,
                p.occurred_at_utc,
                p.credit,
                p.debit,
                p.balance,
                p.peer,
                p.bank_description,
                p.comment,
                p.is_correcting,
            ])
            .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    let validation_errors =
        validate_account_chain(conn, account_id).map_err(|e| e.to_string())?;

    Ok(ImportResult {
        batch_id,
        inserted: parsed.len() as i64,
        corrections_inserted: corrections.len() as i64,
        validation_errors,
    })
}

/// Walk a chain that merges existing DB context (head + interval + tail)
/// with the freshly parsed import rows, and emit a synthetic "correcting"
/// row at every break that touches at least one new import row.
///
/// The correcting row is placed 1ms before `curr` and constructed so that
/// `prev → correcting → curr` reconciles locally:
///   correcting.balance = curr.balance - curr.credit + curr.debit
///   correcting.delta   = correcting.balance - prev.balance
fn synthesize_corrections(
    conn: &Connection,
    account_id: i64,
    parsed: &[ParsedRow],
    batch_tz_offset: &str,
) -> Result<Vec<ParsedRow>, String> {
    if parsed.is_empty() {
        return Ok(vec![]);
    }

    let mut sorted_idx: Vec<usize> = (0..parsed.len()).collect();
    sorted_idx.sort_by(|&a, &b| parsed[a].occurred_at_utc.cmp(&parsed[b].occurred_at_utc));
    let min_t = parsed[sorted_idx[0]].occurred_at_utc.clone();
    let max_t = parsed[*sorted_idx.last().unwrap()].occurred_at_utc.clone();

    let mut interval_stmt = conn
        .prepare(
            "SELECT occurred_at_utc, credit, debit, balance
             FROM transactions
             WHERE account_id = ?1 AND occurred_at_utc >= ?2 AND occurred_at_utc <= ?3
             ORDER BY occurred_at_utc ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let interval: Vec<DbRecord> = interval_stmt
        .query_map(params![account_id, min_t, max_t], db_record_from_row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;

    let head: Option<DbRecord> = conn
        .query_row(
            "SELECT occurred_at_utc, credit, debit, balance
             FROM transactions
             WHERE account_id = ?1 AND occurred_at_utc < ?2
             ORDER BY occurred_at_utc DESC, id DESC
             LIMIT 1",
            params![account_id, min_t],
            db_record_from_row,
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let tail: Option<DbRecord> = conn
        .query_row(
            "SELECT occurred_at_utc, credit, debit, balance
             FROM transactions
             WHERE account_id = ?1 AND occurred_at_utc > ?2
             ORDER BY occurred_at_utc ASC, id ASC
             LIMIT 1",
            params![account_id, max_t],
            db_record_from_row,
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let mut chain: Vec<ChainItem> = Vec::new();
    if let Some(h) = &head {
        chain.push(ChainItem {
            origin: ItemOrigin::Db,
            occurred_at_utc: h.occurred_at_utc.clone(),
            credit: h.credit,
            debit: h.debit,
            balance: h.balance,
        });
    }
    for r in &interval {
        chain.push(ChainItem {
            origin: ItemOrigin::Db,
            occurred_at_utc: r.occurred_at_utc.clone(),
            credit: r.credit,
            debit: r.debit,
            balance: r.balance,
        });
    }
    for (idx, p) in parsed.iter().enumerate() {
        chain.push(ChainItem {
            origin: ItemOrigin::Import { row_index: idx },
            occurred_at_utc: p.occurred_at_utc.clone(),
            credit: p.credit,
            debit: p.debit,
            balance: p.balance,
        });
    }
    if let Some(t) = &tail {
        chain.push(ChainItem {
            origin: ItemOrigin::Db,
            occurred_at_utc: t.occurred_at_utc.clone(),
            credit: t.credit,
            debit: t.debit,
            balance: t.balance,
        });
    }
    chain.sort_by(|a, b| {
        a.occurred_at_utc.cmp(&b.occurred_at_utc).then_with(|| {
            origin_priority(&a.origin).cmp(&origin_priority(&b.origin))
        })
    });

    let mut corrections: Vec<ParsedRow> = Vec::new();
    for i in 1..chain.len() {
        let prev = &chain[i - 1];
        let curr = &chain[i];
        let expected = prev.balance + curr.credit - curr.debit;
        if expected == curr.balance {
            continue;
        }
        // Skip pre-existing DB-only breaks — those existed before this
        // import and are not our concern. Any break that touches at least
        // one new import row gets an auto-correcting entry, including
        // within-file gaps where the bank export itself was incomplete.
        let prev_import = matches!(prev.origin, ItemOrigin::Import { .. });
        let curr_import = matches!(curr.origin, ItemOrigin::Import { .. });
        if !prev_import && !curr_import {
            continue;
        }

        let target_balance = curr.balance - curr.credit + curr.debit;
        let delta = target_balance - prev.balance;
        let (credit, debit) = if delta >= 0 { (delta, 0) } else { (0, -delta) };

        let curr_dt = DateTime::parse_from_rfc3339(&curr.occurred_at_utc)
            .map_err(|e| format!("invalid stored timestamp '{}': {e}", curr.occurred_at_utc))?;
        let new_dt = curr_dt - chrono::Duration::milliseconds(1);
        let new_utc = new_dt
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true);

        corrections.push(ParsedRow {
            occurred_at_utc: new_utc,
            occurred_at_tz: batch_tz_offset.to_string(),
            credit,
            debit,
            balance: target_balance,
            peer: None,
            bank_description: None,
            comment: None,
            is_correcting: true,
        });
    }

    Ok(corrections)
}

#[tauri::command]
pub fn list_transactions(
    state: State<'_, DbState>,
    account_ids: Option<Vec<i64>>,
) -> Result<Vec<Transaction>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let ids = account_ids.unwrap_or_default();
    let where_clause = if ids.is_empty() {
        String::new()
    } else {
        let placeholders = std::iter::repeat("?")
            .take(ids.len())
            .collect::<Vec<_>>()
            .join(",");
        format!("WHERE account_id IN ({placeholders})")
    };
    let sql = format!(
        "SELECT {TXN_COLUMNS} FROM transactions {where_clause} \
         ORDER BY occurred_at_utc ASC, id ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), txn_from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Earliest *local* transaction date among the given accounts (or all
/// accounts when `account_ids` is None/empty), formatted as `YYYY-MM-DD`.
/// "Local" means converted using each transaction's batch timezone offset,
/// matching how the report aggregator places transactions into period
/// columns — so the returned date is the exact lower bound that contains
/// every transaction without leading empty periods.
///
/// Used by the report screen to resolve the "all_time" preset to "earliest
/// real data" rather than 1970, which would generate thousands of empty
/// periods.
#[tauri::command]
pub fn first_transaction_date(
    state: State<'_, DbState>,
    account_ids: Option<Vec<i64>>,
) -> Result<Option<String>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let ids = account_ids.unwrap_or_default();
    let where_clause = if ids.is_empty() {
        String::new()
    } else {
        let placeholders = std::iter::repeat("?")
            .take(ids.len())
            .collect::<Vec<_>>()
            .join(",");
        format!("WHERE t.account_id IN ({placeholders})")
    };
    // We can't pre-filter by MIN(occurred_at_utc) and convert just that one,
    // because earliest UTC ≠ earliest local across timezones. Pull every
    // (utc, tz) pair, convert each, and reduce to the minimum NaiveDate.
    // Cash transactions have no import batch and therefore no batch-level
    // timezone offset — fall back to UTC for them. The local-date conversion
    // is only used to pick the earliest column in the report, where UTC is a
    // fine fallback for entries the user authored manually.
    let sql = format!(
        "SELECT t.occurred_at_utc, COALESCE(b.timezone_offset, '+00:00')
         FROM transactions t
         LEFT JOIN import_batches b ON t.import_batch_id = b.id
         {where_clause}"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;

    let mut earliest: Option<chrono::NaiveDate> = None;
    for row in rows {
        let (utc, tz) = row.map_err(|e| e.to_string())?;
        let local = crate::reports::local_date(&utc, &tz)?;
        earliest = Some(match earliest {
            Some(prev) if prev <= local => prev,
            _ => local,
        });
    }
    Ok(earliest.map(|d| d.format("%Y-%m-%d").to_string()))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountLatestTransaction {
    pub account_id: i64,
    /// UTC timestamp of the most recent transaction.
    pub occurred_at_utc: String,
    /// Timezone offset of the import batch the transaction belongs to —
    /// the frontend converts UTC → local with it for display.
    pub timezone_offset: String,
    /// Net amount in minor units, decimal-formatted. Positive for credits,
    /// negative for debits. Frontend pairs it with the account's currency.
    pub amount_minor: String,
}

fn collect_latest_transactions(
    conn: &Connection,
) -> rusqlite::Result<Vec<AccountLatestTransaction>> {
    // For each account take the row with the maximum occurred_at_utc; ties
    // (multiple txns at the same instant) are broken by id so the result
    // is deterministic.
    let mut stmt = conn.prepare(
        "SELECT t.account_id, t.occurred_at_utc, COALESCE(b.timezone_offset, '+00:00'),
                t.credit, t.debit
         FROM transactions t
         LEFT JOIN import_batches b ON b.id = t.import_batch_id
         JOIN (
             SELECT account_id, MAX(occurred_at_utc) AS max_utc
             FROM transactions
             GROUP BY account_id
         ) m ON m.account_id = t.account_id
            AND m.max_utc = t.occurred_at_utc
         WHERE t.id = (
             SELECT MAX(id) FROM transactions
             WHERE account_id = t.account_id
               AND occurred_at_utc = t.occurred_at_utc
         )",
    )?;
    let rows = stmt.query_map([], |r| {
        let account_id: i64 = r.get(0)?;
        let occurred_at_utc: String = r.get(1)?;
        let tz: String = r.get(2)?;
        let credit: i64 = r.get(3)?;
        let debit: i64 = r.get(4)?;
        Ok(AccountLatestTransaction {
            account_id,
            occurred_at_utc,
            timezone_offset: tz,
            amount_minor: money::format_minor(credit - debit),
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

/// Latest transaction per account, intended for the accounts table column
/// that nudges the user to reload data when an account looks stale.
#[tauri::command]
pub fn latest_transactions(
    state: State<'_, DbState>,
) -> Result<Vec<AccountLatestTransaction>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    collect_latest_transactions(&conn).map_err(|e| e.to_string())
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
pub fn update_transaction_comment(
    state: State<'_, DbState>,
    id: i64,
    comment: Option<String>,
) -> Result<(), String> {
    let normalized = comment
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    let conn = state.lock().map_err(|e| e.to_string())?;
    let updated = conn
        .execute(
            "UPDATE transactions SET comment = ?1 WHERE id = ?2",
            params![normalized, id],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        return Err(format!("transaction {id} does not exist"));
    }
    Ok(())
}

/// Fetch a single transaction by id. Used by the per-transaction view/edit
/// modal, which can be opened from any screen that lists transactions.
#[tauri::command]
pub fn get_transaction(state: State<'_, DbState>, id: i64) -> Result<Transaction, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    crate::cash_transactions::fetch_transaction(&conn, id)
}

/// Update the free-text fields of any transaction (bank or cash): counterparty
/// (`peer`), bank description and comment. These are safe to edit on imported
/// statement rows — unlike amounts/dates/balance they don't touch the
/// balance-chain invariant. Cash-account amounts/dates are edited through
/// `update_cash_transaction` instead, which recomputes running balances.
/// Empty/whitespace strings normalize to NULL.
#[tauri::command]
pub fn update_transaction_fields(
    state: State<'_, DbState>,
    id: i64,
    peer: Option<String>,
    bank_description: Option<String>,
    comment: Option<String>,
) -> Result<Transaction, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    update_transaction_fields_inner(&conn, id, peer, bank_description, comment)
}

pub(crate) fn update_transaction_fields_inner(
    conn: &Connection,
    id: i64,
    peer: Option<String>,
    bank_description: Option<String>,
    comment: Option<String>,
) -> Result<Transaction, String> {
    let norm = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let peer = norm(peer);
    let bank_description = norm(bank_description);
    let comment = norm(comment);
    let updated = conn
        .execute(
            "UPDATE transactions SET peer = ?1, bank_description = ?2, comment = ?3 WHERE id = ?4",
            params![peer, bank_description, comment, id],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        return Err(format!("transaction {id} does not exist"));
    }
    crate::cash_transactions::fetch_transaction(conn, id)
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
    bank_description: Option<String>,
    comment: Option<String>,
}

pub(crate) fn validate_account_chain(
    conn: &Connection,
    account_id: i64,
) -> rusqlite::Result<Vec<ValidationError>> {
    // Cash accounts have their balance chain authored by us — every insert /
    // update / delete already recomputes the running balance, so a "gap" can
    // only exist if the DB was tampered with directly. Bank statement
    // validation does not apply.
    let kind: Option<String> = conn
        .query_row(
            "SELECT kind FROM accounts WHERE id = ?1",
            [account_id],
            |r| r.get(0),
        )
        .optional()?;
    if kind.as_deref() == Some("cash") {
        return Ok(Vec::new());
    }

    let mut stmt = conn.prepare(
        "SELECT id, occurred_at_utc, credit, debit, balance, bank_description, comment
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
                bank_description: r.get(5)?,
                comment: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    Ok(check_chain(&txns))
}

#[derive(Debug, Clone)]
struct DbRecord {
    occurred_at_utc: String,
    credit: i64,
    debit: i64,
    balance: i64,
}

fn db_record_from_row(row: &Row) -> rusqlite::Result<DbRecord> {
    Ok(DbRecord {
        occurred_at_utc: row.get(0)?,
        credit: row.get(1)?,
        debit: row.get(2)?,
        balance: row.get(3)?,
    })
}

#[derive(Debug, Clone, Copy)]
enum ItemOrigin {
    Db,
    Import { row_index: usize },
}

#[derive(Debug)]
struct ChainItem {
    origin: ItemOrigin,
    occurred_at_utc: String,
    credit: i64,
    debit: i64,
    balance: i64,
}

fn origin_priority(o: &ItemOrigin) -> u8 {
    match o {
        ItemOrigin::Db => 0,
        ItemOrigin::Import { .. } => 1,
    }
}

/// Transaction identity for de-duplication. Two rows are the same transaction
/// iff they share the same minute, credit, debit and resulting balance — money
/// fields alone pin a ledger position (two distinct ops can't leave the same
/// balance at the same time), so the free-form description/peer/comment are
/// deliberately excluded. This keeps dedup robust against description drift
/// (CSV↔PDF, parser changes, manual edits) and sub-minute time differences
/// between sources. Applies to every import format, since all funnel through
/// `compute_preview_issues`.
#[derive(Hash, Eq, PartialEq, Clone)]
struct DupeKey {
    occurred_at_minute: String,
    credit: i64,
    debit: i64,
    balance: i64,
}

/// Truncate an RFC3339 UTC timestamp to minute precision for dedup matching
/// ("2026-04-21T00:08:30.500Z" → "2026-04-21T00:08"). Falls back to the raw
/// string if it can't be parsed (shouldn't happen — both DB and parsed rows go
/// through `parse_row`).
fn dedupe_minute(occurred_at_utc: &str) -> String {
    DateTime::parse_from_rfc3339(occurred_at_utc)
        .map(|dt| dt.with_timezone(&Utc).format("%Y-%m-%dT%H:%M").to_string())
        .unwrap_or_else(|_| occurred_at_utc.to_string())
}

/// Start of the minute containing `occurred_at_utc` ("…T10:00:05.500Z" →
/// "…T10:00:00.000Z"). Used to widen the DB lookup window so a duplicate logged
/// with different seconds still falls inside the interval scanned for dupes.
fn minute_floor(occurred_at_utc: &str) -> String {
    DateTime::parse_from_rfc3339(occurred_at_utc)
        .map(|dt| dt.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:00.000Z").to_string())
        .unwrap_or_else(|_| occurred_at_utc.to_string())
}

/// End of the minute containing `occurred_at_utc` ("…T10:00:05.500Z" →
/// "…T10:00:59.999Z"). Counterpart to [`minute_floor`] for the upper bound.
fn minute_ceil(occurred_at_utc: &str) -> String {
    DateTime::parse_from_rfc3339(occurred_at_utc)
        .map(|dt| dt.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:59.999Z").to_string())
        .unwrap_or_else(|_| occurred_at_utc.to_string())
}

#[tauri::command]
pub fn validate_import_preview(
    state: State<'_, DbState>,
    account_id: i64,
    default_timezone_offset: String,
    rows: Vec<TxnImportRow>,
) -> Result<ImportPreviewValidation, String> {
    if rows.is_empty() {
        return Ok(ImportPreviewValidation { row_issues: vec![] });
    }

    let default_offset = parse_offset_str(&default_timezone_offset)?;
    let parsed: Vec<ParsedRow> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            parse_row(r, &default_offset).map_err(|e| format!("row {}: {e}", i + 1))
        })
        .collect::<Result<_, _>>()?;

    let conn = state.lock().map_err(|e| e.to_string())?;

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

    let issues =
        compute_preview_issues(&conn, account_id, &parsed).map_err(|e| e.to_string())?;
    Ok(ImportPreviewValidation { row_issues: issues })
}

fn compute_preview_issues(
    conn: &Connection,
    account_id: i64,
    parsed: &[ParsedRow],
) -> rusqlite::Result<Vec<PreviewRowIssue>> {
    if parsed.is_empty() {
        return Ok(vec![]);
    }

    let mut sorted_idx: Vec<usize> = (0..parsed.len()).collect();
    sorted_idx.sort_by(|&a, &b| parsed[a].occurred_at_utc.cmp(&parsed[b].occurred_at_utc));
    let min_t = parsed[sorted_idx[0]].occurred_at_utc.clone();
    let max_t = parsed[*sorted_idx.last().unwrap()].occurred_at_utc.clone();
    // Widen to whole-minute boundaries: dedup matches at minute precision, so a
    // DB twin logged with different seconds must still land inside the scanned
    // interval (not be split off into head/tail).
    let min_bound = minute_floor(&min_t);
    let max_bound = minute_ceil(&max_t);

    let mut interval_stmt = conn.prepare(
        "SELECT occurred_at_utc, credit, debit, balance
         FROM transactions
         WHERE account_id = ?1 AND occurred_at_utc >= ?2 AND occurred_at_utc <= ?3
         ORDER BY occurred_at_utc ASC, id ASC",
    )?;
    let interval: Vec<DbRecord> = interval_stmt
        .query_map(params![account_id, min_bound, max_bound], db_record_from_row)?
        .collect::<rusqlite::Result<_>>()?;

    let head: Option<DbRecord> = conn
        .query_row(
            "SELECT occurred_at_utc, credit, debit, balance
             FROM transactions
             WHERE account_id = ?1 AND occurred_at_utc < ?2
             ORDER BY occurred_at_utc DESC, id DESC
             LIMIT 1",
            params![account_id, min_bound],
            db_record_from_row,
        )
        .optional()?;

    let tail: Option<DbRecord> = conn
        .query_row(
            "SELECT occurred_at_utc, credit, debit, balance
             FROM transactions
             WHERE account_id = ?1 AND occurred_at_utc > ?2
             ORDER BY occurred_at_utc ASC, id ASC
             LIMIT 1",
            params![account_id, max_bound],
            db_record_from_row,
        )
        .optional()?;

    let mut issues: Vec<PreviewRowIssue> = Vec::new();

    // Step 1: duplicate detection runs first. A duplicated row swallows all
    // other checks for that index — we don't want to chase balance breaks
    // through rows we're not going to import anyway.
    let db_keys: HashSet<DupeKey> = interval
        .iter()
        .map(|r| DupeKey {
            occurred_at_minute: dedupe_minute(&r.occurred_at_utc),
            credit: r.credit,
            debit: r.debit,
            balance: r.balance,
        })
        .collect();
    let mut seen_imports: HashMap<DupeKey, usize> = HashMap::new();
    let mut dup_set: HashSet<usize> = HashSet::new();
    for (idx, p) in parsed.iter().enumerate() {
        let key = DupeKey {
            occurred_at_minute: dedupe_minute(&p.occurred_at_utc),
            credit: p.credit,
            debit: p.debit,
            balance: p.balance,
        };
        if db_keys.contains(&key) {
            dup_set.insert(idx);
            issues.push(PreviewRowIssue {
                row_index: idx,
                kind: "duplicate_db".to_string(),
                expected_balance: None,
                actual_balance: None,
            });
        } else if seen_imports.contains_key(&key) {
            dup_set.insert(idx);
            issues.push(PreviewRowIssue {
                row_index: idx,
                kind: "duplicate_file".to_string(),
                expected_balance: None,
                actual_balance: None,
            });
        } else {
            seen_imports.insert(key, idx);
        }
    }

    // Step 2: balance chain check. Skip rows already flagged as duplicates.
    let mut chain: Vec<ChainItem> = Vec::new();
    if let Some(h) = &head {
        chain.push(ChainItem {
            origin: ItemOrigin::Db,
            occurred_at_utc: h.occurred_at_utc.clone(),
            credit: h.credit,
            debit: h.debit,
            balance: h.balance,
        });
    }
    for r in &interval {
        chain.push(ChainItem {
            origin: ItemOrigin::Db,
            occurred_at_utc: r.occurred_at_utc.clone(),
            credit: r.credit,
            debit: r.debit,
            balance: r.balance,
        });
    }
    for (idx, p) in parsed.iter().enumerate() {
        chain.push(ChainItem {
            origin: ItemOrigin::Import { row_index: idx },
            occurred_at_utc: p.occurred_at_utc.clone(),
            credit: p.credit,
            debit: p.debit,
            balance: p.balance,
        });
    }
    if let Some(t) = &tail {
        chain.push(ChainItem {
            origin: ItemOrigin::Db,
            occurred_at_utc: t.occurred_at_utc.clone(),
            credit: t.credit,
            debit: t.debit,
            balance: t.balance,
        });
    }
    chain.sort_by(|a, b| {
        a.occurred_at_utc.cmp(&b.occurred_at_utc).then_with(|| {
            origin_priority(&a.origin).cmp(&origin_priority(&b.origin))
        })
    });

    let mut balance_seen: HashSet<usize> = HashSet::new();
    for i in 1..chain.len() {
        let prev = &chain[i - 1];
        let curr = &chain[i];
        let expected = prev.balance + curr.credit - curr.debit;
        if expected == curr.balance {
            continue;
        }
        // If the involved import row is a duplicate, no balance issue is
        // emitted for it — duplicates take precedence and the row won't be
        // imported anyway.
        let attribute_to: Option<usize> = match curr.origin {
            ItemOrigin::Import { row_index } if !dup_set.contains(&row_index) => {
                Some(row_index)
            }
            ItemOrigin::Import { .. } => None,
            ItemOrigin::Db => chain[..=i].iter().rev().find_map(|x| match x.origin {
                ItemOrigin::Import { row_index } if !dup_set.contains(&row_index) => {
                    Some(row_index)
                }
                _ => None,
            }),
        };
        let Some(idx) = attribute_to else { continue };
        if !balance_seen.insert(idx) {
            continue;
        }
        // If either side of the broken pair is from the DB the discrepancy
        // is "vs DB"; if both sides are import rows it's "in file".
        let kind = match (curr.origin, prev.origin) {
            (ItemOrigin::Import { .. }, ItemOrigin::Import { .. }) => "balance_file",
            _ => "balance_db",
        };
        issues.push(PreviewRowIssue {
            row_index: idx,
            kind: kind.to_string(),
            expected_balance: Some(money::format_minor(expected)),
            actual_balance: Some(money::format_minor(curr.balance)),
        });
    }

    Ok(issues)
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
                bank_description: curr.bank_description.clone(),
                comment: curr.comment.clone(),
            });
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::params;
    use tempfile::TempDir;

    fn row(id: i64, credit: i64, debit: i64, balance: i64) -> ChainRow {
        ChainRow {
            id,
            occurred_at_utc: format!("2026-04-01T00:00:0{id}Z"),
            credit,
            debit,
            balance,
            bank_description: Some(format!("txn {id}")),
            comment: None,
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

    fn fixture_two_accounts() -> (TempDir, rusqlite::Connection, i64, i64) {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();

        let a1: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('B1', 'USD', '1', 'A') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let a2: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('B2', 'EUR', '2', 'B') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();

        for &acc in &[a1, a2] {
            let batch: i64 = conn
                .query_row(
                    "INSERT INTO import_batches
                     (account_id, imported_at, source_filename, row_count, timezone_offset)
                     VALUES (?1, '2026-01-01T00:00:00Z', NULL, 2, '+00:00') RETURNING id",
                    params![acc],
                    |r| r.get(0),
                )
                .unwrap();
            conn.execute(
                "INSERT INTO transactions
                 (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES
                 (?1, ?2, '2026-01-01T10:00:00Z', 1000, 0, 1000),
                 (?1, ?2, '2026-01-02T10:00:00Z', 500,  0, 1500)",
                params![acc, batch],
            )
            .unwrap();
        }
        (dir, conn, a1, a2)
    }

    fn list_with_filter(conn: &rusqlite::Connection, ids: &[i64]) -> Vec<i64> {
        let where_clause = if ids.is_empty() {
            String::new()
        } else {
            let placeholders = std::iter::repeat("?")
                .take(ids.len())
                .collect::<Vec<_>>()
                .join(",");
            format!("WHERE account_id IN ({placeholders})")
        };
        let sql = format!(
            "SELECT account_id FROM transactions {where_clause} \
             ORDER BY occurred_at_utc ASC, id ASC"
        );
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| r.get::<_, i64>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    #[test]
    fn list_transactions_empty_filter_returns_all() {
        let (_dir, conn, a1, a2) = fixture_two_accounts();
        let result = list_with_filter(&conn, &[]);
        assert_eq!(result.len(), 4);
        assert_eq!(
            result.iter().filter(|&&x| x == a1).count(),
            2,
            "should include account 1"
        );
        assert_eq!(
            result.iter().filter(|&&x| x == a2).count(),
            2,
            "should include account 2"
        );
    }

    #[test]
    fn list_transactions_single_id_filters() {
        let (_dir, conn, a1, _a2) = fixture_two_accounts();
        let result = list_with_filter(&conn, &[a1]);
        assert_eq!(result.len(), 2);
        assert!(result.iter().all(|&x| x == a1));
    }

    #[test]
    fn list_transactions_multiple_ids_returns_union() {
        let (_dir, conn, a1, a2) = fixture_two_accounts();
        let result = list_with_filter(&conn, &[a1, a2]);
        assert_eq!(result.len(), 4);
    }

    #[test]
    fn list_transactions_unknown_id_returns_empty() {
        let (_dir, conn, _a1, _a2) = fixture_two_accounts();
        let result = list_with_filter(&conn, &[9999]);
        assert!(result.is_empty());
    }

    fn parsed(
        occurred: &str,
        peer: &str,
        credit: i64,
        debit: i64,
        balance: i64,
        bank_description: &str,
    ) -> ParsedRow {
        let opt_str = |s: &str| {
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        };
        ParsedRow {
            occurred_at_utc: occurred.to_string(),
            occurred_at_tz: "+00:00".to_string(),
            credit,
            debit,
            balance,
            peer: opt_str(peer),
            bank_description: opt_str(bank_description),
            comment: None,
            is_correcting: false,
        }
    }

    fn fixture_account_with_batch() -> (TempDir, rusqlite::Connection, i64, i64) {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let a: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('B', 'USD', '1', 'A') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let batch: i64 = conn
            .query_row(
                "INSERT INTO import_batches
                 (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-01-01T00:00:00Z', NULL, 0, '+00:00') RETURNING id",
                params![a],
                |r| r.get(0),
            )
            .unwrap();
        (dir, conn, a, batch)
    }

    fn insert_db_txn(
        conn: &rusqlite::Connection,
        account_id: i64,
        batch_id: i64,
        occurred: &str,
        peer: &str,
        credit: i64,
        debit: i64,
        balance: i64,
        bank_description: &str,
    ) {
        let peer_opt: Option<&str> = if peer.is_empty() { None } else { Some(peer) };
        let bank_opt: Option<&str> = if bank_description.is_empty() {
            None
        } else {
            Some(bank_description)
        };
        conn.execute(
            "INSERT INTO transactions
             (account_id, import_batch_id, occurred_at_utc, credit, debit, balance,
              peer, bank_description, comment)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)",
            params![
                account_id,
                batch_id,
                occurred,
                credit,
                debit,
                balance,
                peer_opt,
                bank_opt
            ],
        )
        .unwrap();
    }

    #[test]
    fn preview_empty_returns_no_issues() {
        let (_dir, conn, a, _b) = fixture_account_with_batch();
        let issues = compute_preview_issues(&conn, a, &[]).unwrap();
        assert!(issues.is_empty());
    }

    #[test]
    fn preview_internal_consistent_no_db_no_issues() {
        let (_dir, conn, a, _b) = fixture_account_with_batch();
        let rows = vec![
            parsed("2026-04-01T10:00:00Z", "p1", 0, 0, 1000, ""),
            parsed("2026-04-02T10:00:00Z", "p2", 500, 0, 1500, ""),
            parsed("2026-04-03T10:00:00Z", "p3", 0, 200, 1300, ""),
        ];
        let issues = compute_preview_issues(&conn, a, &rows).unwrap();
        assert!(issues.is_empty(), "{:?}", issues);
    }

    #[test]
    fn preview_internal_break_attributed_to_broken_row() {
        let (_dir, conn, a, _b) = fixture_account_with_batch();
        let rows = vec![
            parsed("2026-04-01T10:00:00Z", "p1", 0, 0, 1000, ""),
            parsed("2026-04-02T10:00:00Z", "p2", 500, 0, 1700, ""), // expected 1500
            parsed("2026-04-03T10:00:00Z", "p3", 0, 200, 1500, ""), // ok vs prev
        ];
        let issues = compute_preview_issues(&conn, a, &rows).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].row_index, 1);
        assert_eq!(issues[0].kind, "balance_file");
        assert_eq!(issues[0].expected_balance.as_deref(), Some("15.00"));
        assert_eq!(issues[0].actual_balance.as_deref(), Some("17.00"));
    }

    #[test]
    fn preview_db_head_boundary_break_marks_first_import() {
        let (_dir, conn, a, b) = fixture_account_with_batch();
        insert_db_txn(&conn, a, b, "2026-03-31T10:00:00Z", "salary", 0, 0, 1000, "");
        let rows = vec![
            parsed("2026-04-01T10:00:00Z", "p1", 200, 0, 1300, ""), // expected 1200
            parsed("2026-04-02T10:00:00Z", "p2", 0, 100, 1200, ""), // ok vs prev
        ];
        let issues = compute_preview_issues(&conn, a, &rows).unwrap();
        let balance: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == "balance_db")
            .collect();
        assert_eq!(balance.len(), 1);
        assert_eq!(balance[0].row_index, 0);
        assert_eq!(balance[0].expected_balance.as_deref(), Some("12.00"));
        assert_eq!(balance[0].actual_balance.as_deref(), Some("13.00"));
    }

    #[test]
    fn preview_db_tail_boundary_break_marks_last_import() {
        let (_dir, conn, a, b) = fixture_account_with_batch();
        insert_db_txn(&conn, a, b, "2026-04-10T10:00:00Z", "later", 0, 50, 950, "");
        let rows = vec![
            parsed("2026-04-01T10:00:00Z", "p1", 0, 0, 1000, ""),
            parsed("2026-04-02T10:00:00Z", "p2", 0, 100, 900, ""),
        ];
        let issues = compute_preview_issues(&conn, a, &rows).unwrap();
        // curr=DB tail, prev=last import → involves DB → balance_db
        let balance: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == "balance_db")
            .collect();
        assert_eq!(balance.len(), 1);
        assert_eq!(balance[0].row_index, 1);
        assert_eq!(balance[0].expected_balance.as_deref(), Some("8.50"));
        assert_eq!(balance[0].actual_balance.as_deref(), Some("9.50"));
    }

    #[test]
    fn preview_duplicate_with_db_marks_import_row() {
        let (_dir, conn, a, b) = fixture_account_with_batch();
        insert_db_txn(
            &conn,
            a,
            b,
            "2026-04-01T10:00:00.000Z",
            "shop",
            0,
            300,
            700,
            "groceries",
        );
        let rows = vec![
            parsed("2026-04-01T10:00:00.000Z", "shop", 0, 300, 700, "groceries"),
            parsed("2026-04-02T10:00:00.000Z", "p2", 100, 0, 800, ""),
        ];
        let issues = compute_preview_issues(&conn, a, &rows).unwrap();
        let dupe: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == "duplicate_db")
            .collect();
        assert_eq!(dupe.len(), 1);
        assert_eq!(dupe[0].row_index, 0);
    }

    #[test]
    fn preview_duplicate_within_imports_marks_later_occurrences() {
        let (_dir, conn, a, _b) = fixture_account_with_batch();
        let rows = vec![
            parsed("2026-04-01T10:00:00Z", "p1", 0, 0, 1000, "a"),
            parsed("2026-04-01T10:00:00Z", "p1", 0, 0, 1000, "a"),
            parsed("2026-04-01T10:00:00Z", "p1", 0, 0, 1000, "a"),
        ];
        let issues = compute_preview_issues(&conn, a, &rows).unwrap();
        let dupe: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == "duplicate_file")
            .collect();
        assert_eq!(dupe.len(), 2, "first occurrence kept, others flagged");
        assert_eq!(dupe[0].row_index, 1);
        assert_eq!(dupe[1].row_index, 2);
    }

    #[test]
    fn preview_duplicate_swallows_balance_check() {
        // Row 0 is a duplicate of an existing DB record. Row 1 has a balance
        // gap, but that gap stems from row 0 being broken. Since row 0 is a
        // duplicate it must NOT also be flagged with a balance issue.
        let (_dir, conn, a, b) = fixture_account_with_batch();
        insert_db_txn(
            &conn,
            a,
            b,
            "2026-03-31T10:00:00Z",
            "shop",
            0,
            300,
            700,
            "groceries",
        );
        let rows = vec![
            // Same key as the DB row above — duplicate_db
            parsed("2026-03-31T10:00:00Z", "shop", 0, 300, 700, "groceries"),
            // Internally consistent with row 0
            parsed("2026-04-01T10:00:00Z", "p2", 0, 100, 600, ""),
        ];
        let issues = compute_preview_issues(&conn, a, &rows).unwrap();
        let dup: Vec<_> = issues.iter().filter(|i| i.row_index == 0).collect();
        assert_eq!(dup.len(), 1);
        assert_eq!(dup[0].kind, "duplicate_db");
        // Row 0 must not have a balance issue even if the chain check would
        // otherwise emit one.
        assert!(!issues
            .iter()
            .any(|i| i.row_index == 0 && i.kind.starts_with("balance")));
    }

    #[test]
    fn preview_money_identity_dedupes_despite_description() {
        // Dedup keys on money + minute only, not the free-form description. Two
        // rows with the same time/credit/debit/balance but different peer and
        // bank_description are the same transaction — the later one is a dupe.
        let (_dir, conn, a, _b) = fixture_account_with_batch();
        let rows = vec![
            parsed("2026-04-01T10:00:00Z", "p1", 0, 0, 1000, "alpha"),
            parsed("2026-04-01T10:00:00Z", "p2", 0, 0, 1000, "beta"),
        ];
        let issues = compute_preview_issues(&conn, a, &rows).unwrap();
        let dupe: Vec<_> = issues
            .iter()
            .filter(|i| i.kind == "duplicate_file")
            .collect();
        assert_eq!(dupe.len(), 1, "different description still dedupes");
        assert_eq!(dupe[0].row_index, 1);
    }

    #[test]
    fn preview_db_dupe_despite_description_has_no_phantom_balance() {
        // Real-world bug: an import row matching a DB row on money but with a
        // drifted description (e.g. a page-wrapped detail lost on re-parse) must
        // be a duplicate_db — NOT a phantom balance discrepancy from being
        // double-counted against its own DB twin in the chain.
        let (_dir, conn, a, b) = fixture_account_with_batch();
        insert_db_txn(
            &conn,
            a,
            b,
            "2026-04-21T07:08:00.000Z",
            "To PromptPay X6534 BUNTHAM KHAITHONG ++",
            0,
            5000,
            553190,
            "Transfer Withdrawal · K PLUS · To PromptPay X6534 BUNTHAM KHAITHONG ++",
        );
        // Re-import where the wrapped detail tail got dropped → different peer
        // and bank_description, identical money.
        let rows = vec![parsed(
            "2026-04-21T07:08:00.000Z",
            "To PromptPay X6534 BUNTHAM",
            0,
            5000,
            553190,
            "Transfer Withdrawal · K PLUS · To PromptPay X6534 BUNTHAM",
        )];
        let issues = compute_preview_issues(&conn, a, &rows).unwrap();
        assert!(
            issues.iter().any(|i| i.row_index == 0 && i.kind == "duplicate_db"),
            "money-identical row is a DB duplicate"
        );
        assert!(
            !issues
                .iter()
                .any(|i| i.row_index == 0 && i.kind.starts_with("balance")),
            "no phantom balance discrepancy on the duplicate row"
        );
    }

    #[test]
    fn preview_dedupe_tolerates_sub_minute_time_difference() {
        // Dedup matches at minute precision, so the same transaction logged with
        // different seconds across sources still counts as a duplicate.
        let (_dir, conn, a, b) = fixture_account_with_batch();
        insert_db_txn(
            &conn,
            a,
            b,
            "2026-04-01T10:00:05.000Z",
            "shop",
            0,
            300,
            700,
            "groceries",
        );
        let rows = vec![parsed("2026-04-01T10:00:40.000Z", "shop", 0, 300, 700, "groceries")];
        let issues = compute_preview_issues(&conn, a, &rows).unwrap();
        assert!(
            issues.iter().any(|i| i.row_index == 0 && i.kind == "duplicate_db"),
            "sub-minute time drift still dedupes"
        );
        assert!(
            !issues
                .iter()
                .any(|i| i.row_index == 0 && i.kind.starts_with("balance")),
        );
    }

    #[test]
    fn synthesize_no_corrections_when_chain_is_clean() {
        let (_dir, conn, a, _b) = fixture_account_with_batch();
        let rows = vec![
            parsed("2026-04-01T10:00:00Z", "p1", 0, 0, 1000, ""),
            parsed("2026-04-02T10:00:00Z", "p2", 500, 0, 1500, ""),
        ];
        let corr = synthesize_corrections(&conn, a, &rows, "+00:00").unwrap();
        assert!(corr.is_empty());
    }

    #[test]
    fn synthesize_corrects_within_file_break() {
        // Pure within-file gap: DB has nothing, but row 1 has +200 unexpected
        // jump. Now auto-corrected so the on-disk chain stays consistent.
        let (_dir, conn, a, _b) = fixture_account_with_batch();
        let rows = vec![
            parsed("2026-04-01T10:00:00Z", "p1", 0, 0, 1000, ""),
            parsed("2026-04-02T10:00:00Z", "p2", 500, 0, 1700, ""), // expected 1500
            parsed("2026-04-03T10:00:00Z", "p3", 0, 200, 1500, ""),
        ];
        let corr = synthesize_corrections(&conn, a, &rows, "+00:00").unwrap();
        assert_eq!(corr.len(), 1);
        let c = &corr[0];
        assert!(c.is_correcting);
        // target = curr.balance - curr.credit = 1700 - 500 = 1200
        // delta = 1200 - 1000 = 200 → credit 200
        assert_eq!(c.balance, 1200);
        assert_eq!(c.credit, 200);
        assert_eq!(c.debit, 0);
        assert_eq!(c.occurred_at_utc, "2026-04-02T09:59:59.999Z");
    }

    #[test]
    fn synthesize_skips_pre_existing_db_break() {
        // DB already has a broken chain. Import sits clearly after it and
        // is internally consistent. The pre-existing DB break must not be
        // touched — only breaks that touch the new batch are corrected.
        let (_dir, conn, a, b) = fixture_account_with_batch();
        // DB[0]: balance 1000
        insert_db_txn(&conn, a, b, "2026-03-01T10:00:00Z", "x", 0, 0, 1000, "");
        // DB[1]: claims balance 1500 with credit 100 → broken (expected 1100)
        insert_db_txn(&conn, a, b, "2026-03-02T10:00:00Z", "y", 100, 0, 1500, "");
        // Import continues from DB[1] consistently.
        let rows = vec![parsed("2026-04-01T10:00:00Z", "p1", 0, 200, 1300, "")];
        let corr = synthesize_corrections(&conn, a, &rows, "+00:00").unwrap();
        assert!(corr.is_empty(), "pre-existing DB break must not be corrected: {:?}", corr);
    }

    #[test]
    fn synthesize_corrects_db_head_boundary() {
        // DB at T0 ends at balance 1000. First import row introduces a +10 gap.
        let (_dir, conn, a, b) = fixture_account_with_batch();
        insert_db_txn(&conn, a, b, "2026-03-31T10:00:00Z", "salary", 0, 0, 1000, "");
        let rows = vec![
            parsed("2026-04-01T10:00:00Z", "p1", 200, 0, 1300, ""), // expected 1200
            parsed("2026-04-02T10:00:00Z", "p2", 0, 100, 1200, ""),
        ];
        let corr = synthesize_corrections(&conn, a, &rows, "+00:00").unwrap();
        assert_eq!(corr.len(), 1);
        let c = &corr[0];
        assert!(c.is_correcting);
        // Target balance for the correcting txn = curr.balance - curr.credit
        //                                       = 1300 - 200 = 1100
        assert_eq!(c.balance, 1100);
        // delta = 1100 - 1000 = 100 → credit
        assert_eq!(c.credit, 100);
        assert_eq!(c.debit, 0);
        // Inserted 1ms before curr (2026-04-01T10:00:00Z)
        assert_eq!(c.occurred_at_utc, "2026-04-01T09:59:59.999Z");
        assert!(c.peer.is_none());
        assert!(c.bank_description.is_none());
        assert!(c.comment.is_none());
    }

    #[test]
    fn synthesize_corrects_db_tail_boundary_with_negative_delta() {
        // DB tail comes after the import. Last import balance breaks chain to tail.
        let (_dir, conn, a, b) = fixture_account_with_batch();
        // Tail: balance 950 with debit 50 → expected_prev=1000
        insert_db_txn(&conn, a, b, "2026-04-10T10:00:00Z", "later", 0, 50, 950, "");
        let rows = vec![
            parsed("2026-04-01T10:00:00Z", "p1", 0, 0, 1000, ""),
            // Internally consistent end balance 900 — but DB tail expects 1000.
            parsed("2026-04-02T10:00:00Z", "p2", 0, 100, 900, ""),
        ];
        let corr = synthesize_corrections(&conn, a, &rows, "+00:00").unwrap();
        assert_eq!(corr.len(), 1);
        let c = &corr[0];
        // target_balance = tail.balance - tail.credit + tail.debit = 950 - 0 + 50 = 1000
        // delta = 1000 - 900 = 100 → credit 100
        assert_eq!(c.balance, 1000);
        assert_eq!(c.credit, 100);
        assert_eq!(c.debit, 0);
        // 1ms before tail (2026-04-10T10:00:00Z)
        assert_eq!(c.occurred_at_utc, "2026-04-10T09:59:59.999Z");
    }

    #[test]
    fn import_inserts_correcting_row_and_chain_becomes_consistent() {
        let (_dir, conn, a, b) = fixture_account_with_batch();
        insert_db_txn(&conn, a, b, "2026-03-31T10:00:00Z", "salary", 0, 0, 1000, "");
        let rows = vec![
            parsed("2026-04-01T10:00:00Z", "p1", 200, 0, 1300, ""), // gap +100 vs DB
            parsed("2026-04-02T10:00:00Z", "p2", 0, 100, 1200, ""),
        ];
        let corr = synthesize_corrections(&conn, a, &rows, "+00:00").unwrap();
        assert_eq!(corr.len(), 1);

        // Materialise: insert all rows + corrections into a fresh batch and
        // confirm validate_account_chain returns no errors.
        let batch: i64 = conn
            .query_row(
                "INSERT INTO import_batches
                 (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-04-15T00:00:00Z', NULL, 3, '+00:00') RETURNING id",
                params![a],
                |r| r.get(0),
            )
            .unwrap();
        for p in rows.iter().chain(corr.iter()) {
            conn.execute(
                "INSERT INTO transactions
                 (account_id, import_batch_id, occurred_at_utc, credit, debit, balance,
                  peer, bank_description, comment, is_correcting)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    a,
                    batch,
                    p.occurred_at_utc,
                    p.credit,
                    p.debit,
                    p.balance,
                    p.peer,
                    p.bank_description,
                    p.comment,
                    p.is_correcting,
                ],
            )
            .unwrap();
        }
        let errs = validate_account_chain(&conn, a).unwrap();
        assert!(errs.is_empty(), "chain should be consistent after correction: {:?}", errs);
    }

    #[test]
    fn collect_latest_transactions_returns_one_row_per_account() {
        let (_dir, conn, a1, a2) = fixture_two_accounts();
        // a1: two txns; latest is the credit.
        insert_db_txn(&conn, a1, 1, "2026-03-01T10:00:00Z", "Vendor", 0, 5000, 95000, "early");
        insert_db_txn(&conn, a1, 1, "2026-04-15T10:00:00Z", "Salary", 200000, 0, 295000, "latest a1");
        // a2: single txn (debit).
        insert_db_txn(&conn, a2, 2, "2026-04-20T10:00:00Z", "Rent", 0, 75000, 25000, "latest a2");

        let mut got = collect_latest_transactions(&conn).unwrap();
        got.sort_by_key(|r| r.account_id);

        assert_eq!(got.len(), 2);
        assert_eq!(got[0].account_id, a1);
        assert_eq!(got[0].occurred_at_utc, "2026-04-15T10:00:00Z");
        assert_eq!(got[0].amount_minor, "2000.00");
        assert_eq!(got[1].account_id, a2);
        assert_eq!(got[1].occurred_at_utc, "2026-04-20T10:00:00Z");
        // Outgoing → negative.
        assert_eq!(got[1].amount_minor, "-750.00");
    }

    #[test]
    fn collect_latest_transactions_omits_accounts_without_transactions() {
        // Build a clean DB with two accounts; only one gets a transaction.
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let a1: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('B1', 'USD', '1', 'A') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let a2: i64 = conn
            .query_row(
                "INSERT INTO accounts (bank, currency, account_number, owner_name)
                 VALUES ('B2', 'EUR', '2', 'B') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let batch: i64 = conn
            .query_row(
                "INSERT INTO import_batches
                 (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, '2026-01-01T00:00:00Z', NULL, 0, '+00:00') RETURNING id",
                params![a1],
                |r| r.get(0),
            )
            .unwrap();
        insert_db_txn(&conn, a1, batch, "2026-04-01T10:00:00Z", "Anyone", 1000, 0, 1000, "only");

        let got = collect_latest_transactions(&conn).unwrap();
        assert_eq!(got.len(), 1, "a2 has no transactions and must be omitted");
        assert_eq!(got[0].account_id, a1);
        // Sanity: a2 exists but is silent.
        let a2_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions WHERE account_id = ?1", [a2], |r| r.get(0))
            .unwrap();
        assert_eq!(a2_count, 0);
    }

    #[test]
    fn update_transaction_fields_overwrites_text_columns() {
        let (_dir, conn, a, b) = fixture_account_with_batch();
        insert_db_txn(&conn, a, b, "2026-04-01T10:00:00Z", "Old peer", 1000_00, 0, 1000_00, "Old desc");
        let id: i64 = conn
            .query_row("SELECT id FROM transactions LIMIT 1", [], |r| r.get(0))
            .unwrap();

        let updated = update_transaction_fields_inner(
            &conn,
            id,
            Some("  New peer  ".to_string()),
            Some("New desc".to_string()),
            Some("A comment".to_string()),
        )
        .unwrap();
        assert_eq!(updated.peer.as_deref(), Some("New peer")); // trimmed
        assert_eq!(updated.bank_description.as_deref(), Some("New desc"));
        assert_eq!(updated.comment.as_deref(), Some("A comment"));
    }

    #[test]
    fn update_transaction_fields_blanks_normalize_to_null() {
        let (_dir, conn, a, b) = fixture_account_with_batch();
        insert_db_txn(&conn, a, b, "2026-04-01T10:00:00Z", "Peer", 1000_00, 0, 1000_00, "Desc");
        let id: i64 = conn
            .query_row("SELECT id FROM transactions LIMIT 1", [], |r| r.get(0))
            .unwrap();

        let updated = update_transaction_fields_inner(
            &conn,
            id,
            Some("   ".to_string()),
            None,
            Some("".to_string()),
        )
        .unwrap();
        assert!(updated.peer.is_none());
        assert!(updated.bank_description.is_none());
        assert!(updated.comment.is_none());
    }

    #[test]
    fn update_transaction_fields_missing_id_errors() {
        let (_dir, conn, _a, _b) = fixture_account_with_batch();
        let res = update_transaction_fields_inner(&conn, 99999, None, None, None);
        assert!(res.is_err());
    }
}
