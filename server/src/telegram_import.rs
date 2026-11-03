//! Cash-account import of a Telegram channel export. The file is parsed and
//! its messages sorted in the browser (`src/lib/telegram-export.ts`), the owner
//! checks them in the wizard, and this module keeps what the wizard needs to
//! remember: the channel bound to the account and the decision on each message.
//! See `docs/plans/telegram-cash-import.md`.

use std::collections::{HashMap, HashSet};

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::cash_transactions::{
    delete_row, ensure_cash_account, insert_cash_row, normalize_occurred_at, normalize_optional,
    recompute_cash_balances, CashDirection,
};
use crate::category_agent as agent;
use crate::db::DbState;
use crate::host::State;
use crate::money;

const STATUS_IMPORTED: &str = "imported";
const STATUS_SKIPPED: &str = "skipped";

const ERR_EMPTY_TITLE: &str = "telegram_import.empty_title";
const ERR_ALREADY_IMPORTED: &str = "telegram_import.already_imported";
const ERR_BATCH_NOT_FOUND: &str = "telegram_import.batch_not_found";

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelegramChannel {
    pub title: String,
    pub timezone_offset: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramMessageState {
    pub message_id: i64,
    pub status: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramBatch {
    pub id: i64,
    pub imported_at: String,
    pub source_filename: Option<String>,
    pub imported: i64,
    pub skipped: i64,
}

/// A channel bound to another cash account: its file must not go here too.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramOtherChannel {
    pub account_name: String,
    pub title: String,
}

/// A message left for review, as the wizard saved it.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramPending {
    pub message_id: i64,
    pub text: String,
    pub date: String,
    pub time: String,
    pub rows_json: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramImportState {
    pub channel: Option<TelegramChannel>,
    pub messages: Vec<TelegramMessageState>,
    pub pending: Vec<TelegramPending>,
    pub batches: Vec<TelegramBatch>,
    pub other_channels: Vec<TelegramOtherChannel>,
}

fn load_state(conn: &Connection, account_id: i64) -> rusqlite::Result<TelegramImportState> {
    let channel = conn
        .query_row(
            "SELECT title, timezone_offset FROM telegram_channels WHERE account_id = ?1",
            [account_id],
            |r| Ok(TelegramChannel { title: r.get(0)?, timezone_offset: r.get(1)? }),
        )
        .optional()?;

    let mut stmt = conn.prepare(
        "SELECT message_id, status, text FROM telegram_messages WHERE account_id = ?1",
    )?;
    let messages = stmt
        .query_map([account_id], |r| {
            Ok(TelegramMessageState { message_id: r.get(0)?, status: r.get(1)?, text: r.get(2)? })
        })?
        .collect::<rusqlite::Result<_>>()?;

    let mut stmt = conn.prepare(
        "SELECT message_id, text, date, time, rows_json FROM telegram_pending
         WHERE account_id = ?1 ORDER BY message_id",
    )?;
    let pending = stmt
        .query_map([account_id], |r| {
            Ok(TelegramPending {
                message_id: r.get(0)?,
                text: r.get(1)?,
                date: r.get(2)?,
                time: r.get(3)?,
                rows_json: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    // Newest first. A batch of this account with no decisions is not ours.
    let mut stmt = conn.prepare(
        "SELECT b.id, b.imported_at, b.source_filename, b.row_count,
                SUM(m.status = 'skipped')
         FROM import_batches b
         JOIN telegram_messages m ON m.batch_id = b.id
         WHERE b.account_id = ?1
         GROUP BY b.id
         ORDER BY b.id DESC",
    )?;
    let batches = stmt
        .query_map([account_id], |r| {
            Ok(TelegramBatch {
                id: r.get(0)?,
                imported_at: r.get(1)?,
                source_filename: r.get(2)?,
                imported: r.get(3)?,
                skipped: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    let mut stmt = conn.prepare(
        "SELECT COALESCE(NULLIF(a.name, ''), a.currency), c.title
         FROM telegram_channels c
         JOIN accounts a ON a.id = c.account_id
         WHERE c.account_id <> ?1",
    )?;
    let other_channels = stmt
        .query_map([account_id], |r| {
            Ok(TelegramOtherChannel { account_name: r.get(0)?, title: r.get(1)? })
        })?
        .collect::<rusqlite::Result<_>>()?;

    Ok(TelegramImportState { channel, messages, pending, batches, other_channels })
}

pub fn get_telegram_import_state(
    state: State<'_, DbState>,
    account_id: i64,
) -> Result<TelegramImportState, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    ensure_cash_account(&conn, account_id)?;
    load_state(&conn, account_id).map_err(|e| e.to_string())
}

fn save_channel(
    conn: &Connection,
    account_id: i64,
    title: &str,
    timezone_offset: &str,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(ERR_EMPTY_TITLE.to_string());
    }
    conn.execute(
        "INSERT INTO telegram_channels (account_id, title, timezone_offset)
         VALUES (?1, ?2, ?3)
         ON CONFLICT (account_id) DO UPDATE
         SET title = excluded.title, timezone_offset = excluded.timezone_offset",
        params![account_id, title, timezone_offset],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The channel's name is the owner's to edit: the channel may get renamed
/// regardless of them.
pub fn set_telegram_channel(
    state: State<'_, DbState>,
    account_id: i64,
    title: String,
    timezone_offset: String,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    ensure_cash_account(&conn, account_id)?;
    save_channel(&conn, account_id, &title, &timezone_offset)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramEntryInput {
    pub occurred_at_utc: String,
    pub direction: CashDirection,
    pub amount: String,
    pub category_id: Option<i64>,
    pub comment: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramDecisionInput {
    pub message_id: i64,
    pub text: String,
    /// Several rows when the owner split the message; none means it is skipped.
    pub entries: Vec<TelegramEntryInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramEditedInput {
    pub message_id: i64,
    pub text: String,
}

/// Write the owner's decisions in one SQL transaction: the rows of the imported
/// messages under a new batch, every decision so the message is not offered
/// again, the messages left for review, the edited messages as seen. Returns the
/// number of rows created.
pub fn commit_telegram_import(
    state: State<'_, DbState>,
    account_id: i64,
    title: String,
    timezone_offset: String,
    source_filename: Option<String>,
    decisions: Vec<TelegramDecisionInput>,
    pending: Vec<TelegramPending>,
    edited: Vec<TelegramEditedInput>,
) -> Result<usize, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let conn: &mut Connection = &mut guard;
    ensure_cash_account(conn, account_id)?;
    // Without the `<<--->>` categories: they belong to linked pairs only.
    let allowed: HashMap<i64, bool> = agent::agent_category_paths(conn)?
        .into_iter()
        .map(|(id, _, kind, ..)| (id, kind == "income"))
        .collect();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    save_channel(&tx, account_id, &title, &timezone_offset)?;

    let imported: HashSet<i64> = {
        let mut stmt = tx
            .prepare("SELECT message_id FROM telegram_messages WHERE account_id = ?1 AND status = ?2")
            .map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map(params![account_id, STATUS_IMPORTED], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?;
        ids
    };

    let mut created = 0;
    if !decisions.is_empty() {
        let batch_id: i64 = tx
            .query_row(
                "INSERT INTO import_batches (account_id, imported_at, source_filename, row_count, timezone_offset)
                 VALUES (?1, ?2, ?3, 0, ?4) RETURNING id",
                params![
                    account_id,
                    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                    source_filename,
                    timezone_offset
                ],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        let mut earliest: Option<String> = None;
        for d in &decisions {
            // The same file in a second window, or a double submit.
            if imported.contains(&d.message_id) {
                return Err(ERR_ALREADY_IMPORTED.to_string());
            }
            for e in &d.entries {
                let occurred_at = normalize_occurred_at(&e.occurred_at_utc)?;
                let minor = money::parse_minor(&e.amount).map_err(|err| err.to_string())?;
                if minor <= 0 {
                    return Err(format!("amount '{}' must be positive", e.amount));
                }
                let incoming = matches!(e.direction, CashDirection::In);
                if let Some(id) = e.category_id {
                    if allowed.get(&id) != Some(&incoming) {
                        return Err(format!(
                            "category {id} does not fit an {} entry",
                            if incoming { "income" } else { "expense" }
                        ));
                    }
                }
                let (credit, debit) = if incoming { (minor, 0) } else { (0, minor) };
                let comment = normalize_optional(e.comment.clone());
                let id = insert_cash_row(&tx, account_id, &occurred_at, credit, debit, None, comment.as_deref())?;
                tx.execute("UPDATE transactions SET import_batch_id = ?1 WHERE id = ?2", params![batch_id, id])
                    .map_err(|e| e.to_string())?;
                if let Some(category_id) = e.category_id {
                    tx.execute(
                        "INSERT INTO transaction_categories (transaction_id, category_id, share_minor, position)
                         VALUES (?1, ?2, ?3, 0)",
                        params![id, category_id, minor],
                    )
                    .map_err(|e| e.to_string())?;
                }
                if earliest.as_ref().is_none_or(|t| occurred_at < *t) {
                    earliest = Some(occurred_at);
                }
                created += 1;
            }
            let status = if d.entries.is_empty() { STATUS_SKIPPED } else { STATUS_IMPORTED };
            tx.execute(
                "INSERT INTO telegram_messages (account_id, message_id, status, text, batch_id)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (account_id, message_id) DO UPDATE
                 SET status = excluded.status, text = excluded.text, batch_id = excluded.batch_id",
                params![account_id, d.message_id, status, d.text, batch_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM telegram_pending WHERE account_id = ?1 AND message_id = ?2",
                params![account_id, d.message_id],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute("UPDATE import_batches SET row_count = ?1 WHERE id = ?2", params![created as i64, batch_id])
            .map_err(|e| e.to_string())?;
        if let Some(from) = earliest {
            recompute_cash_balances(&tx, account_id, &from).map_err(|e| e.to_string())?;
        }
    }

    for p in &pending {
        if imported.contains(&p.message_id) {
            return Err(ERR_ALREADY_IMPORTED.to_string());
        }
        tx.execute(
            "INSERT INTO telegram_pending (account_id, message_id, text, date, time, rows_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (account_id, message_id) DO UPDATE
             SET text = excluded.text, date = excluded.date, time = excluded.time,
                 rows_json = excluded.rows_json",
            params![account_id, p.message_id, p.text, p.date, p.time, p.rows_json],
        )
        .map_err(|e| e.to_string())?;
    }

    for e in &edited {
        tx.execute(
            "UPDATE telegram_messages SET text = ?1
             WHERE account_id = ?2 AND message_id = ?3 AND status = ?4",
            params![e.text, account_id, e.message_id, STATUS_IMPORTED],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(created)
}

/// Roll one import back: its rows go (a bank debit linked to one since then
/// loses the transfer category, as on any unlink), its decisions are forgotten
/// by cascade, so the same file offers those messages again.
pub fn delete_telegram_import(
    state: State<'_, DbState>,
    account_id: i64,
    batch_id: i64,
) -> Result<usize, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let conn: &mut Connection = &mut guard;
    ensure_cash_account(conn, account_id)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let ours: bool = tx
        .query_row(
            "SELECT EXISTS (
                 SELECT 1 FROM import_batches b
                 JOIN telegram_messages m ON m.batch_id = b.id
                 WHERE b.id = ?1 AND b.account_id = ?2
             )",
            params![batch_id, account_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !ours {
        return Err(ERR_BATCH_NOT_FOUND.to_string());
    }
    let rows: Vec<(i64, String)> = {
        let mut stmt = tx
            .prepare("SELECT id, occurred_at_utc FROM transactions WHERE import_batch_id = ?1 ORDER BY occurred_at_utc")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([batch_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for (id, _) in &rows {
        delete_row(&tx, *id)?;
    }
    tx.execute("DELETE FROM import_batches WHERE id = ?1", [batch_id])
        .map_err(|e| e.to_string())?;
    if let Some((_, from)) = rows.first() {
        recompute_cash_balances(&tx, account_id, from).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::sync::Mutex;
    use tempfile::TempDir;

    struct Fx {
        _dir: TempDir,
        state: DbState,
        cash: i64,
        expense: i64,
        debit_txn: i64,
    }

    fn fixture() -> Fx {
        let dir = TempDir::new().unwrap();
        let conn = db::open(dir.path()).unwrap();
        let cash = conn
            .query_row(
                "INSERT INTO accounts (name, kind, bank, currency) VALUES ('Cash', 'cash', 'Cash', 'THB') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let bank: i64 = conn
            .query_row(
                "INSERT INTO accounts (name, kind, bank, currency, account_number, owner_name)
                 VALUES ('Bank', 'bank', 'TestBank', 'THB', '1', 'Owner') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let batch: i64 = conn
            .query_row(
                "INSERT INTO import_batches (account_id, imported_at, row_count, timezone_offset)
                 VALUES (?1, '2026-01-01T00:00:00Z', 1, '+00:00') RETURNING id",
                [bank],
                |r| r.get(0),
            )
            .unwrap();
        let debit_txn = conn
            .query_row(
                "INSERT INTO transactions (account_id, import_batch_id, occurred_at_utc, credit, debit, balance)
                 VALUES (?1, ?2, '2026-01-10T03:00:00.000Z', 0, 100000, 0) RETURNING id",
                params![bank, batch],
                |r| r.get(0),
            )
            .unwrap();
        let expense = conn
            .query_row(
                "INSERT INTO categories (name, color, kind) VALUES ('Food', '#000000', 'expense') RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        Fx { _dir: dir, state: Mutex::new(conn), cash, expense, debit_txn }
    }

    fn entry(at: &str, direction: CashDirection, amount: &str) -> TelegramEntryInput {
        TelegramEntryInput {
            occurred_at_utc: at.to_string(),
            direction,
            amount: amount.to_string(),
            category_id: None,
            comment: Some("synthetic".to_string()),
        }
    }

    fn decision(message_id: i64, entries: Vec<TelegramEntryInput>) -> TelegramDecisionInput {
        TelegramDecisionInput { message_id, text: format!("text {message_id}"), entries }
    }

    fn commit(f: &Fx, decisions: Vec<TelegramDecisionInput>) -> Result<usize, String> {
        commit_telegram_import(
            &f.state,
            f.cash,
            "Test channel".to_string(),
            "+07:00".to_string(),
            Some("messages.html".to_string()),
            decisions,
            vec![],
            vec![],
        )
    }

    fn balances(f: &Fx) -> Vec<i64> {
        let conn = f.state.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT balance FROM transactions WHERE account_id = ?1 ORDER BY occurred_at_utc, id")
            .unwrap();
        let rows = stmt
            .query_map([f.cash], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<i64>>>()
            .unwrap();
        rows
    }

    fn state_of(f: &Fx) -> TelegramImportState {
        get_telegram_import_state(&f.state, f.cash).unwrap()
    }

    #[test]
    fn commit_creates_rows_and_remembers_every_decision() {
        let f = fixture();
        let mut with_category = entry("2026-01-02T05:00:00Z", CashDirection::Out, "200");
        with_category.category_id = Some(f.expense);
        let created = commit(
            &f,
            vec![
                decision(2, vec![with_category]),
                decision(1, vec![entry("2026-01-01T05:00:00Z", CashDirection::In, "1000")]),
                decision(3, vec![]),
            ],
        )
        .unwrap();
        assert_eq!(created, 2);
        assert_eq!(balances(&f), [100000, 80000]);

        let st = state_of(&f);
        assert_eq!(
            st.channel,
            Some(TelegramChannel { title: "Test channel".to_string(), timezone_offset: "+07:00".to_string() })
        );
        let by_id: HashMap<i64, &str> = st.messages.iter().map(|m| (m.message_id, m.status.as_str())).collect();
        assert_eq!(by_id[&1], STATUS_IMPORTED);
        assert_eq!(by_id[&3], STATUS_SKIPPED);
        assert_eq!((st.batches[0].imported, st.batches[0].skipped), (2, 1));

        let conn = f.state.lock().unwrap();
        let share: i64 = conn
            .query_row("SELECT share_minor FROM transaction_categories WHERE category_id = ?1", [f.expense], |r| r.get(0))
            .unwrap();
        assert_eq!(share, 20000);
    }

    #[test]
    fn a_split_message_gives_several_rows() {
        let f = fixture();
        let created = commit(
            &f,
            vec![decision(
                1,
                vec![
                    entry("2026-01-01T05:00:00Z", CashDirection::Out, "70"),
                    entry("2026-01-01T05:00:00Z", CashDirection::Out, "25"),
                ],
            )],
        )
        .unwrap();
        assert_eq!(created, 2);
        assert_eq!(balances(&f), [-7000, -9500]);
    }

    #[test]
    fn an_imported_message_cannot_be_imported_again() {
        let f = fixture();
        commit(&f, vec![decision(1, vec![entry("2026-01-01T05:00:00Z", CashDirection::Out, "70")])]).unwrap();
        let err = commit(&f, vec![decision(1, vec![entry("2026-01-01T05:00:00Z", CashDirection::Out, "70")])]).unwrap_err();
        assert_eq!(err, ERR_ALREADY_IMPORTED);
        assert_eq!(balances(&f).len(), 1, "the failed commit left nothing behind");
    }

    #[test]
    fn a_skipped_message_can_be_imported_later() {
        let f = fixture();
        commit(&f, vec![decision(1, vec![])]).unwrap();
        commit(&f, vec![decision(1, vec![entry("2026-01-01T05:00:00Z", CashDirection::Out, "70")])]).unwrap();
        let st = state_of(&f);
        assert_eq!(st.messages.len(), 1);
        assert_eq!(st.messages[0].status, STATUS_IMPORTED);
    }

    #[test]
    fn rollback_removes_rows_forgets_decisions_and_recomputes_the_balance() {
        let f = fixture();
        commit(&f, vec![decision(1, vec![entry("2026-01-01T05:00:00Z", CashDirection::In, "1000")])]).unwrap();
        commit(
            &f,
            vec![decision(2, vec![entry("2026-01-10T05:00:00Z", CashDirection::In, "1000")]), decision(3, vec![])],
        )
        .unwrap();
        // Linked by hand after the import.
        {
            let conn = f.state.lock().unwrap();
            let imported: i64 = conn
                .query_row(
                    "SELECT id FROM transactions WHERE account_id = ?1 AND occurred_at_utc LIKE '2026-01-10%'",
                    [f.cash],
                    |r| r.get(0),
                )
                .unwrap();
            crate::transaction_links::insert_link_unchecked(&conn, f.debit_txn, imported).unwrap();
        }
        commit(&f, vec![decision(4, vec![entry("2026-01-20T05:00:00Z", CashDirection::Out, "100")])]).unwrap();
        assert_eq!(balances(&f), [100000, 200000, 190000]);

        let st = state_of(&f);
        let middle = st.batches[1].id;
        assert_eq!(delete_telegram_import(&f.state, f.cash, middle).unwrap(), 1);
        assert_eq!(balances(&f), [100000, 90000]);

        let ids: HashSet<i64> = state_of(&f).messages.iter().map(|m| m.message_id).collect();
        assert_eq!(ids, HashSet::from([1, 4]));
        let conn = f.state.lock().unwrap();
        let links: i64 = conn.query_row("SELECT COUNT(*) FROM transaction_links", [], |r| r.get(0)).unwrap();
        assert_eq!(links, 0);
        let debit_categories: i64 = conn
            .query_row("SELECT COUNT(*) FROM transaction_categories WHERE transaction_id = ?1", [f.debit_txn], |r| r.get(0))
            .unwrap();
        assert_eq!(debit_categories, 0, "the debit lost its transfer category");
    }

    #[test]
    fn rollback_refuses_a_batch_that_is_not_a_telegram_import() {
        let f = fixture();
        let foreign = {
            let conn = f.state.lock().unwrap();
            conn.query_row(
                "INSERT INTO import_batches (account_id, imported_at, row_count, timezone_offset)
                 VALUES (?1, '2026-01-01T00:00:00Z', 0, '+00:00') RETURNING id",
                [f.cash],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
        };
        assert_eq!(delete_telegram_import(&f.state, f.cash, foreign).unwrap_err(), ERR_BATCH_NOT_FOUND);
    }

    #[test]
    fn an_edited_message_is_marked_as_seen() {
        let f = fixture();
        commit(&f, vec![decision(1, vec![entry("2026-01-01T05:00:00Z", CashDirection::Out, "70")])]).unwrap();
        commit_telegram_import(
            &f.state,
            f.cash,
            "Renamed channel".to_string(),
            "+03:00".to_string(),
            None,
            vec![],
            vec![],
            vec![TelegramEditedInput { message_id: 1, text: "new text".to_string() }],
        )
        .unwrap();
        let st = state_of(&f);
        assert_eq!(st.messages[0].text, "new text");
        assert_eq!(st.batches.len(), 1, "no decisions, no new batch");
        assert_eq!(st.channel.unwrap().title, "Renamed channel");
    }

    fn pending(message_id: i64, rows_json: &str) -> TelegramPending {
        TelegramPending {
            message_id,
            text: format!("text {message_id}"),
            date: "2026-01-01".to_string(),
            time: "12:00:00".to_string(),
            rows_json: rows_json.to_string(),
        }
    }

    fn commit_pending(f: &Fx, decisions: Vec<TelegramDecisionInput>, left: Vec<TelegramPending>) -> Result<usize, String> {
        commit_telegram_import(&f.state, f.cash, "Test channel".to_string(), "+07:00".to_string(), None, decisions, left, vec![])
    }

    #[test]
    fn messages_left_for_review_are_kept_with_corrections_until_decided() {
        let f = fixture();
        commit_pending(&f, vec![], vec![pending(1, "[1]"), pending(2, "[2]")]).unwrap();
        let st = state_of(&f);
        assert_eq!(st.pending.len(), 2);
        assert!(st.batches.is_empty(), "saving for later is not an import");
        assert!(balances(&f).is_empty());

        // Saved again: the newer draft replaces the older one.
        commit_pending(&f, vec![], vec![pending(1, "[1, 1]")]).unwrap();
        assert_eq!(state_of(&f).pending[0].rows_json, "[1, 1]");

        // Decided: one imported, one ignored; both leave the list.
        commit_pending(
            &f,
            vec![decision(1, vec![entry("2026-01-01T05:00:00Z", CashDirection::Out, "70")]), decision(2, vec![])],
            vec![],
        )
        .unwrap();
        let st = state_of(&f);
        assert!(st.pending.is_empty());
        assert_eq!(st.messages.len(), 2);
    }

    #[test]
    fn an_imported_message_cannot_be_left_for_review() {
        let f = fixture();
        commit(&f, vec![decision(1, vec![entry("2026-01-01T05:00:00Z", CashDirection::Out, "70")])]).unwrap();
        assert_eq!(commit_pending(&f, vec![], vec![pending(1, "[]")]).unwrap_err(), ERR_ALREADY_IMPORTED);
    }

    #[test]
    fn rollback_keeps_what_is_left_for_review() {
        let f = fixture();
        commit_pending(
            &f,
            vec![decision(1, vec![entry("2026-01-01T05:00:00Z", CashDirection::Out, "70")])],
            vec![pending(2, "[]")],
        )
        .unwrap();
        let batch = state_of(&f).batches[0].id;
        delete_telegram_import(&f.state, f.cash, batch).unwrap();
        assert_eq!(state_of(&f).pending.len(), 1);
    }

    #[test]
    fn the_channel_needs_a_name() {
        let f = fixture();
        let err = set_telegram_channel(&f.state, f.cash, "  ".to_string(), "+07:00".to_string()).unwrap_err();
        assert_eq!(err, ERR_EMPTY_TITLE);
    }
}
