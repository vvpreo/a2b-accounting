//! Cash-account "Regular payments": the wizard copies entries marked with 🔄
//! from a source month into a target month. Which entries to copy is decided
//! by the wizard (`src/lib/regular-payments.ts`), the owner confirms the
//! preview, and this command writes them in one SQL transaction with their
//! category shares. No model is involved.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Deserialize;

use crate::cash_transactions::{
    ensure_cash_account, insert_cash_row, normalize_occurred_at, normalize_optional,
    recompute_cash_balances, CashDirection,
};
use crate::category_agent as agent;
use crate::db::DbState;
use crate::host::State;
use crate::money;
use crate::transaction_categories::CategoryItem;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegularEntryInput {
    pub occurred_at_utc: String,
    pub direction: CashDirection,
    pub amount: String,
    pub categories: Vec<CategoryItem>,
    pub peer: Option<String>,
    pub comment: Option<String>,
}

/// Create the confirmed rows with their shares; the balance is recomputed once
/// from the earliest.
pub fn create_regular_cash_entries(
    state: State<'_, DbState>,
    account_id: i64,
    entries: Vec<RegularEntryInput>,
) -> Result<usize, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let conn: &mut Connection = &mut guard;
    ensure_cash_account(conn, account_id)?;
    if entries.is_empty() {
        return Ok(0);
    }
    // Without the `<<--->>` categories: they belong to linked pairs only.
    let allowed: HashMap<i64, bool> = agent::agent_category_paths(conn)?
        .into_iter()
        .map(|(id, _, kind, ..)| (id, kind == "income"))
        .collect();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut earliest: Option<String> = None;
    for e in &entries {
        let occurred_at = normalize_occurred_at(&e.occurred_at_utc)?;
        let minor = money::parse_minor(&e.amount).map_err(|err| err.to_string())?;
        if minor <= 0 {
            return Err(format!("amount '{}' must be positive", e.amount));
        }
        let incoming = matches!(e.direction, CashDirection::In);
        let mut assigned = 0;
        for c in &e.categories {
            if allowed.get(&c.category_id) != Some(&incoming) {
                return Err(format!(
                    "category {} does not fit an {} entry",
                    c.category_id,
                    if incoming { "income" } else { "expense" }
                ));
            }
            assigned += c.share_minor;
        }
        if assigned > minor {
            return Err(format!("sum of shares {assigned} exceeds the amount {minor}"));
        }
        let (credit, debit) = if incoming { (minor, 0) } else { (0, minor) };
        let peer = normalize_optional(e.peer.clone());
        let comment = normalize_optional(e.comment.clone());
        let id = insert_cash_row(&tx, account_id, &occurred_at, credit, debit, peer.as_deref(), comment.as_deref())?;
        for c in &e.categories {
            tx.execute(
                "INSERT INTO transaction_categories (transaction_id, category_id, share_minor, position)
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, c.category_id, c.share_minor, c.position],
            )
            .map_err(|e| e.to_string())?;
        }
        if earliest.as_ref().is_none_or(|t| occurred_at < *t) {
            earliest = Some(occurred_at);
        }
    }
    if let Some(from) = earliest {
        recompute_cash_balances(&tx, account_id, &from).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(entries.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use tempfile::TempDir;

    struct Fx {
        _dir: TempDir,
        state: DbState,
        cash: i64,
        rent: i64,
        fun: i64,
        salary: i64,
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
        let category = |name: &str, kind: &str| -> i64 {
            conn.query_row(
                "INSERT INTO categories (name, color, kind) VALUES (?1, '#000000', ?2) RETURNING id",
                params![name, kind],
                |r| r.get(0),
            )
            .unwrap()
        };
        let (rent, fun, salary) = (category("Rent", "expense"), category("Fun", "expense"), category("Pay", "income"));
        Fx { _dir: dir, state: std::sync::Mutex::new(conn), cash, rent, fun, salary }
    }

    fn entry(at: &str, amount: &str, categories: Vec<CategoryItem>) -> RegularEntryInput {
        RegularEntryInput {
            occurred_at_utc: at.to_string(),
            direction: CashDirection::Out,
            amount: amount.to_string(),
            categories,
            peer: Some(" Студия ".to_string()),
            comment: Some("🔄 Абонемент".to_string()),
        }
    }

    fn item(category_id: i64, share_minor: i64, position: i64) -> CategoryItem {
        CategoryItem { category_id, share_minor, position }
    }

    #[test]
    fn entries_keep_their_shares_and_the_balance_chain_is_rebuilt() {
        let f = fixture();
        let created = create_regular_cash_entries(
            &f.state,
            f.cash,
            vec![
                entry("2026-11-01T05:00:00Z", "100.00", vec![item(f.rent, 7500, 0), item(f.fun, 2500, 1)]),
                entry("2026-11-01T05:00:00Z", "50.00", vec![]),
            ],
        )
        .unwrap();
        assert_eq!(created, 2);
        let conn = f.state.lock().unwrap();
        let rows: Vec<(i64, i64, i64, Option<String>, Option<String>)> = conn
            .prepare("SELECT id, debit, balance, peer, comment FROM transactions ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(rows.iter().map(|r| (r.1, r.2)).collect::<Vec<_>>(), [(10000, -10000), (5000, -15000)]);
        assert_eq!(rows[0].3.as_deref(), Some("Студия"));
        assert_eq!(rows[0].4.as_deref(), Some("🔄 Абонемент"));
        let shares: Vec<(i64, i64, i64)> = conn
            .prepare("SELECT category_id, share_minor, position FROM transaction_categories WHERE transaction_id = ?1 ORDER BY position")
            .unwrap()
            .query_map([rows[0].0], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(shares, [(f.rent, 7500, 0), (f.fun, 2500, 1)]);
    }

    #[test]
    fn a_bad_entry_creates_nothing() {
        let f = fixture();
        let at = "2026-11-01T05:00:00Z";
        let good = || entry(at, "10.00", vec![]);
        for bad in [
            entry(at, "0", vec![]),
            entry(at, "10.00", vec![item(f.salary, 1000, 0)]),
            entry(at, "10.00", vec![item(f.rent, 1001, 0)]),
        ] {
            assert!(create_regular_cash_entries(&f.state, f.cash, vec![good(), bad]).is_err());
        }
        let count: i64 = f.state.lock().unwrap().query_row("SELECT COUNT(*) FROM transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }
}
