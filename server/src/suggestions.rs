//! Suggestions: what to do with a transaction — withdraw it to cash, link it
//! with a transfer partner on another own bank account, or put it into a
//! category. See `docs/plans/transaction-suggestions.md`.
//!
//! Each kind is produced by its own bulk action over the user's selection
//! (cash withdrawals → transfers → categories, in that order) and stored in
//! `transaction_suggestions`. Nothing is applied automatically: categories,
//! links and cash transactions change only through [`apply_suggestion`],
//! which delegates to the existing commands (`create_cash_withdrawal`,
//! `link_transactions`, `set_transaction_categories`).
//!
//! The rule-based kinds (cash withdrawal, transfer) need no LLM. What a model
//! would see about a transaction is [`SuggestionContext`] — it has no balance
//! field at all, and the facts it is built from never select the balance.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use crate::db::DbState;
use crate::host::State;
use crate::money;

pub const KIND_CATEGORY: &str = "category";
pub const KIND_TRANSFER: &str = "transfer";
pub const KIND_CASH: &str = "cash_withdrawal";

/// Two sides of a transfer between own accounts land within this many seconds
/// of each other; anything further apart the user links by hand.
const TRANSFER_WINDOW_SECS: i64 = 5 * 60;

const ERR_NOT_FOUND: &str = "suggestion.not_found";
const ERR_NOT_PENDING: &str = "suggestion.not_pending";
const ERR_ALREADY_CATEGORIZED: &str = "suggestion.already_categorized";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: i64,
    pub transaction_id: i64,
    pub kind: String,
    pub source: String,
    pub category_id: Option<i64>,
    pub partner_txn_id: Option<i64>,
    pub cash_account_id: Option<i64>,
    pub confidence: i64,
    /// Why the confidence is what it is, in the UI language.
    pub rationale: String,
    /// The model's own reasoning, when it returned any (LLM suggestions only).
    pub reasoning: Option<String>,
    /// Exactly what was sent to the model (LLM suggestions only).
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub created_at: String,
}

/// Outcome of one bulk run: how many suggestions were made and why the other
/// selected transactions were skipped (reason code → count; the UI localises
/// the codes under `suggestions.skip.*`).
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub suggested: i64,
    pub skipped: HashMap<String, i64>,
}

impl RunSummary {
    fn skip(&mut self, reason: &str) {
        *self.skipped.entry(reason.to_string()).or_insert(0) += 1;
    }
}

// ---------------------------------------------------------------------------
// Transaction facts (never the balance)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(crate) struct Facts {
    pub(crate) id: i64,
    pub(crate) account_id: i64,
    pub(crate) account_kind: String,
    pub(crate) account_name: String,
    pub(crate) bank: String,
    pub(crate) account_number: Option<String>,
    pub(crate) owner_name: Option<String>,
    pub(crate) currency: String,
    pub(crate) occurred_at_utc: String,
    pub(crate) at: DateTime<Utc>,
    pub(crate) credit: i64,
    pub(crate) debit: i64,
    pub(crate) peer: Option<String>,
    pub(crate) bank_description: Option<String>,
    pub(crate) comment: Option<String>,
    pub(crate) timezone_offset: Option<String>,
}

impl Facts {
    pub(crate) fn amount(&self) -> i64 {
        self.credit + self.debit
    }

    fn account_label(&self) -> &str {
        if self.account_name.trim().is_empty() {
            &self.bank
        } else {
            &self.account_name
        }
    }

    /// Bank description and counterparty — where banks put masks and keywords.
    fn texts(&self) -> impl Iterator<Item = &str> {
        [self.bank_description.as_deref(), self.peer.as_deref()]
            .into_iter()
            .flatten()
    }
}

/// Every transaction with its account. `t.balance` is deliberately not
/// selected: nothing in this module may see it.
pub(crate) fn load_all_facts(conn: &Connection) -> Result<Vec<Facts>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.account_id, a.kind, a.name, a.bank, a.account_number, a.owner_name,
                    a.currency, t.occurred_at_utc, t.credit, t.debit, t.peer,
                    t.bank_description, t.comment, b.timezone_offset
             FROM transactions t
             JOIN accounts a ON a.id = t.account_id
             LEFT JOIN import_batches b ON b.id = t.import_batch_id
             ORDER BY t.occurred_at_utc, t.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let occurred_at_utc: String = r.get(8)?;
            Ok((
                Facts {
                    id: r.get(0)?,
                    account_id: r.get(1)?,
                    account_kind: r.get(2)?,
                    account_name: r.get(3)?,
                    bank: r.get(4)?,
                    account_number: r.get(5)?,
                    owner_name: r.get(6)?,
                    currency: r.get(7)?,
                    occurred_at_utc: occurred_at_utc.clone(),
                    at: DateTime::<Utc>::MIN_UTC,
                    credit: r.get(9)?,
                    debit: r.get(10)?,
                    peer: r.get(11)?,
                    bank_description: r.get(12)?,
                    comment: r.get(13)?,
                    timezone_offset: r.get(14)?,
                },
                occurred_at_utc,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter_map(|(mut f, raw)| {
            f.at = DateTime::parse_from_rfc3339(raw.trim()).ok()?.with_timezone(&Utc);
            Some(f)
        })
        .collect())
}

pub(crate) fn linked_ids(conn: &Connection) -> Result<HashMap<i64, i64>, String> {
    let mut stmt = conn
        .prepare("SELECT txn_a_id, txn_b_id FROM transaction_links")
        .map_err(|e| e.to_string())?;
    let pairs = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mut map = HashMap::new();
    for (a, b) in pairs {
        map.insert(a, b);
        map.insert(b, a);
    }
    Ok(map)
}

#[derive(Debug, Clone)]
struct Existing {
    status: String,
    input_hash: String,
    partner_txn_id: Option<i64>,
}

impl Existing {
    fn is_pending(&self) -> bool {
        self.status == "pending"
    }
}

fn load_existing(conn: &Connection) -> Result<HashMap<(i64, String), Existing>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT transaction_id, kind, status, input_hash, partner_txn_id
             FROM transaction_suggestions",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                (r.get::<_, i64>(0)?, r.get::<_, String>(1)?),
                Existing {
                    status: r.get(2)?,
                    input_hash: r.get(3)?,
                    partner_txn_id: r.get(4)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

struct NewSuggestion<'a> {
    transaction_id: i64,
    kind: &'a str,
    source: &'a str,
    category_id: Option<i64>,
    partner_txn_id: Option<i64>,
    cash_account_id: Option<i64>,
    confidence: i64,
    rationale: &'a str,
    input_hash: &'a str,
}

/// Insert or replace the (transaction, kind) suggestion as a fresh pending one.
fn upsert(conn: &Connection, s: &NewSuggestion) -> Result<(), String> {
    conn.execute(
        "INSERT INTO transaction_suggestions
           (transaction_id, kind, source, category_id, partner_txn_id, cash_account_id,
            confidence, rationale, reasoning, prompt, model, input_hash, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, NULL, ?9, 'pending',
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (transaction_id, kind) DO UPDATE SET
            source = excluded.source, category_id = excluded.category_id,
            partner_txn_id = excluded.partner_txn_id, cash_account_id = excluded.cash_account_id,
            confidence = excluded.confidence, rationale = excluded.rationale,
            reasoning = NULL, prompt = NULL, model = NULL,
            input_hash = excluded.input_hash, status = 'pending',
            created_at = excluded.created_at",
        params![
            s.transaction_id,
            s.kind,
            s.source,
            s.category_id,
            s.partner_txn_id,
            s.cash_account_id,
            s.confidence.clamp(0, 10),
            s.rationale,
            s.input_hash,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Rationale language
// ---------------------------------------------------------------------------

/// Rationales are written in the UI language (`app_settings.locale`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Lang {
    Ru,
    En,
}

impl Lang {
    pub(crate) fn of(conn: &Connection) -> Lang {
        let locale: Option<String> = conn
            .query_row("SELECT value FROM app_settings WHERE key = 'locale'", [], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        match locale {
            Some(l) if l.trim().to_lowercase().starts_with("ru") => Lang::Ru,
            _ => Lang::En,
        }
    }

    pub(crate) fn pick<'a>(self, ru: &'a str, en: &'a str) -> &'a str {
        match self {
            Lang::Ru => ru,
            Lang::En => en,
        }
    }
}

fn sentence(parts: Vec<String>) -> String {
    let text = parts.join("; ");
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => format!("{}{}.", first.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

fn format_gap(lang: Lang, secs: i64) -> String {
    if secs < 60 {
        format!("{secs} {}", lang.pick("с", "s"))
    } else {
        format!("{} {}", (secs + 30) / 60, lang.pick("мин", "min"))
    }
}

// ---------------------------------------------------------------------------
// Action 1 — withdrawals to cash
// ---------------------------------------------------------------------------

/// Description patterns of a cash withdrawal (ATM or bank counter) and the
/// confidence each one gives. A bare "ATM" is only the channel — weaker.
fn cash_patterns() -> &'static [(Regex, i64)] {
    static PATTERNS: OnceLock<Vec<(Regex, i64)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (r"(?i)\bcash\s+withdrawal\b", 9),
            (r"(?i)\bwithdrawal\b.*\b(atm|counter|branch)\b", 8),
            (r"(?i)\batm\b", 6),
            ("ถอนเงินสด", 8),
            (r"(?i)сняти[ея]\s+наличных", 8),
        ]
        .into_iter()
        .map(|(p, c)| (Regex::new(p).expect("valid regex"), c))
        .collect()
    })
}

/// Operations through an ATM that are not a withdrawal: the ATM fee
/// (`Fee · ATM · …`) and a transfer made at an ATM.
fn not_cash() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\bfees?\b|\btransfer\b|комисси|перевод|ค่าธรรมเนียม|โอน").expect("valid regex")
    })
}

/// The strongest cash-withdrawal signal in the transaction's texts: the
/// confidence and the matched fragment.
fn cash_signal(f: &Facts) -> Option<(i64, String)> {
    if f.texts().any(|t| not_cash().is_match(t)) {
        return None;
    }
    let mut best: Option<(i64, String)> = None;
    for text in f.texts() {
        for (re, confidence) in cash_patterns() {
            if let Some(m) = re.find(text) {
                if best.as_ref().is_none_or(|(c, _)| confidence > c) {
                    best = Some((*confidence, m.as_str().to_string()));
                }
            }
        }
    }
    best
}

struct CashAccountPick {
    id: i64,
    name: String,
    /// How many earlier withdrawals went to this account.
    used: i64,
    /// How many cash accounts in this currency exist.
    of: usize,
}

/// The cash account in this currency; with several, the one earlier
/// withdrawals went to most often.
fn pick_cash_account(conn: &Connection, currency: &str) -> Result<Option<CashAccountPick>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT a.id, a.name,
                    (SELECT COUNT(*) FROM transaction_links l
                       JOIN transactions t ON t.id IN (l.txn_a_id, l.txn_b_id)
                      WHERE t.account_id = a.id AND t.credit > 0) AS used
             FROM accounts a
             WHERE a.kind = 'cash' AND a.currency = ?1
             ORDER BY used DESC, a.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([currency], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let of = rows.len();
    Ok(rows
        .into_iter()
        .next()
        .map(|(id, name, used)| CashAccountPick { id, name, used, of }))
}

fn cash_rationale(lang: Lang, matched: &str, cash: &CashAccountPick, currency: &str) -> String {
    let signal = match lang {
        Lang::Ru => format!("в описании «{matched}» — снятие наличных"),
        Lang::En => format!("the description says “{matched}” — a cash withdrawal"),
    };
    let account = match (lang, cash.of, cash.used) {
        (Lang::Ru, 1, _) => format!("кассовый счёт «{}» — единственный в {currency}", cash.name),
        (Lang::En, 1, _) => format!("“{}” is the only cash account in {currency}", cash.name),
        (Lang::Ru, n, used) if used > 0 => format!(
            "кассовый счёт «{}» — на него чаще всего выводили раньше ({used} раз из {n} кассовых счетов в {currency})",
            cash.name
        ),
        (Lang::En, n, used) if used > 0 => format!(
            "earlier withdrawals went to “{}” most often ({used} times; {n} cash accounts in {currency})",
            cash.name
        ),
        (Lang::Ru, n, _) => format!(
            "кассовый счёт «{}» — первый из {n} кассовых счетов в {currency}, проверьте выбор",
            cash.name
        ),
        (Lang::En, n, _) => format!(
            "“{}” is the first of {n} cash accounts in {currency} — check the choice",
            cash.name
        ),
    };
    sentence(vec![signal, account])
}

fn run_cash_withdrawals(conn: &mut Connection, transaction_ids: &[i64], redo: bool) -> Result<RunSummary, String> {
    let lang = Lang::of(conn);
    let facts: HashMap<i64, Facts> = load_all_facts(conn)?.into_iter().map(|f| (f.id, f)).collect();
    let linked = linked_ids(conn)?;
    let existing = load_existing(conn)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut summary = RunSummary::default();
    for id in transaction_ids {
        let Some(f) = facts.get(id) else {
            summary.skip("not_found");
            continue;
        };
        if f.account_kind != "bank" || f.debit <= 0 {
            summary.skip("not_bank_debit");
            continue;
        }
        if linked.contains_key(&f.id) {
            summary.skip("linked");
            continue;
        }
        let Some((confidence, matched)) = cash_signal(f) else {
            summary.skip("no_signal");
            continue;
        };
        let current = existing.get(&(f.id, KIND_CASH.to_string()));
        if !redo && current.is_some_and(Existing::is_pending) {
            summary.skip("already_suggested");
            continue;
        }
        let Some(cash) = pick_cash_account(&tx, &f.currency)? else {
            summary.skip("no_cash_account");
            continue;
        };
        let input_hash = format!("cash:{}:{}", f.id, cash.id);
        if current.is_some_and(|e| e.status == "dismissed" && e.input_hash == input_hash) {
            summary.skip("dismissed");
            continue;
        }
        // Several cash accounts and no history to choose by — less sure.
        let confidence = if cash.of > 1 && cash.used == 0 { confidence - 2 } else { confidence };
        let rationale = cash_rationale(lang, &matched, &cash, &f.currency);
        upsert(
            &tx,
            &NewSuggestion {
                transaction_id: f.id,
                kind: KIND_CASH,
                source: "rule",
                category_id: None,
                partner_txn_id: None,
                cash_account_id: Some(cash.id),
                confidence,
                rationale: &rationale,
                input_hash: &input_hash,
            },
        )?;
        summary.suggested += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(summary)
}

pub fn detect_cash_withdrawals(
    state: State<'_, DbState>,
    transaction_ids: Vec<i64>,
    redo: bool,
) -> Result<RunSummary, String> {
    let mut conn = state.lock().map_err(|e| e.to_string())?;
    run_cash_withdrawals(&mut conn, &transaction_ids, redo)
}

// ---------------------------------------------------------------------------
// Action 2 — transfers between own bank accounts
// ---------------------------------------------------------------------------

/// Masked account numbers as banks print them: `X3302`, `x6813` (inside
/// `xxx-x-x6813-x`), `BAY X9…`.
fn account_masks(text: &str) -> Vec<String> {
    static MASK: OnceLock<Regex> = OnceLock::new();
    MASK.get_or_init(|| Regex::new(r"(?i)\bx+[-\s]?(\d{4,})").expect("valid regex"))
        .captures_iter(text)
        .map(|c| c[1].to_string())
        .collect()
}

fn digits(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

/// A mask in `from`'s texts that is part of `to`'s account number.
fn mask_pointing_at(from: &Facts, to: &Facts) -> Option<String> {
    let number = digits(to.account_number.as_deref()?);
    if number.len() < 4 {
        return None;
    }
    from.texts()
        .flat_map(account_masks)
        .find(|m| number.contains(m.as_str()))
}

/// `to`'s owner named in `from`'s counterparty (a transfer "to myself").
fn names_owner(from: &Facts, to: &Facts) -> bool {
    let Some(owner) = to.owner_name.as_deref().map(str::trim).filter(|o| o.chars().count() >= 3) else {
        return false;
    };
    from.peer
        .as_deref()
        .is_some_and(|p| p.to_lowercase().contains(&owner.to_lowercase()))
}

fn says_transfer(f: &Facts) -> bool {
    static WORD: OnceLock<Regex> = OnceLock::new();
    let re = WORD.get_or_init(|| Regex::new(r"(?i)transfer|перевод|โอน").expect("valid regex"));
    f.bank_description.as_deref().is_some_and(|d| re.is_match(d))
}

#[derive(Debug, Clone)]
struct Pair {
    /// Canonical: `lo < hi`.
    lo: i64,
    hi: i64,
    score: i64,
    gap_secs: i64,
    rationale_parts: Vec<String>,
}

fn pair_hash(a: i64, b: i64) -> String {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    format!("pair:{lo}:{hi}")
}

/// Score a candidate pair and explain the score. The base — equal amount,
/// opposite direction, same currency, within the window — is 4.
fn score_pair(lang: Lang, x: &Facts, y: &Facts) -> Pair {
    let gap_secs = (x.at - y.at).num_seconds().abs();
    let mut score = 4;
    let mut parts = vec![match lang {
        Lang::Ru => format!(
            "сумма {} {} совпала, направления противоположные, разница во времени {}",
            money::format_minor(x.amount()),
            x.currency,
            format_gap(lang, gap_secs)
        ),
        Lang::En => format!(
            "the amount {} {} matches, opposite directions, {} apart",
            money::format_minor(x.amount()),
            x.currency,
            format_gap(lang, gap_secs)
        ),
    }];
    score += match gap_secs {
        0..=60 => 2,
        61..=180 => 1,
        _ => 0,
    };
    for (from, to) in [(x, y), (y, x)] {
        if let Some(mask) = mask_pointing_at(from, to) {
            score += 3;
            parts.push(match lang {
                Lang::Ru => format!(
                    "в описании на счёте «{}» указан «x{mask}» — это номер счёта «{}»",
                    from.account_label(),
                    to.account_label()
                ),
                Lang::En => format!(
                    "the description on “{}” mentions “x{mask}” — the number of “{}”",
                    from.account_label(),
                    to.account_label()
                ),
            });
        }
    }
    if names_owner(x, y) || names_owner(y, x) {
        score += 1;
        parts.push(lang.pick("контрагент — владелец второго счёта", "the counterparty is the other account's owner").to_string());
    }
    if says_transfer(x) || says_transfer(y) {
        score += 1;
        parts.push(lang.pick("в описании признак перевода", "the description says it is a transfer").to_string());
    }
    let (lo, hi) = if x.id < y.id { (x.id, y.id) } else { (y.id, x.id) };
    Pair { lo, hi, score, gap_secs, rationale_parts: parts }
}

fn run_transfers(conn: &mut Connection, transaction_ids: &[i64], redo: bool) -> Result<RunSummary, String> {
    let lang = Lang::of(conn);
    let all = load_all_facts(conn)?;
    let by_id: HashMap<i64, &Facts> = all.iter().map(|f| (f.id, f)).collect();
    let linked = linked_ids(conn)?;
    let existing = load_existing(conn)?;
    let selection: HashSet<i64> = transaction_ids.iter().copied().collect();
    let pending = |id: i64, kind: &str| {
        existing
            .get(&(id, kind.to_string()))
            .filter(|e| e.is_pending())
    };
    let dismissed_pair = |a: i64, b: i64| {
        let hash = pair_hash(a, b);
        [a, b].iter().any(|id| {
            existing
                .get(&(*id, KIND_TRANSFER.to_string()))
                .is_some_and(|e| e.status == "dismissed" && e.input_hash == hash)
        })
    };

    let mut summary = RunSummary::default();
    let mut eligible: Vec<i64> = Vec::new();
    let mut pairs: HashMap<(i64, i64), Pair> = HashMap::new();
    for id in transaction_ids {
        let Some(x) = by_id.get(id).copied() else {
            summary.skip("not_found");
            continue;
        };
        if x.account_kind != "bank" || x.amount() == 0 {
            summary.skip("not_bank");
            continue;
        }
        if linked.contains_key(&x.id) {
            summary.skip("linked");
            continue;
        }
        if pending(x.id, KIND_CASH).is_some() {
            summary.skip("cash_pending");
            continue;
        }
        if !redo && pending(x.id, KIND_TRANSFER).is_some() {
            summary.skip("already_suggested");
            continue;
        }
        eligible.push(x.id);
        for y in &all {
            let candidate = y.account_kind == "bank"
                && y.account_id != x.account_id
                && y.currency == x.currency
                && y.credit == x.debit
                && y.debit == x.credit
                && (y.at - x.at).num_seconds().abs() <= TRANSFER_WINDOW_SECS
                && !linked.contains_key(&y.id)
                && pending(y.id, KIND_CASH).is_none()
                // A partner already promised to someone else keeps its pair,
                // unless that pair is being recomputed in this very run.
                && pending(y.id, KIND_TRANSFER).is_none_or(|e| {
                    e.partner_txn_id == Some(x.id) || (redo && selection.contains(&y.id))
                })
                && !dismissed_pair(x.id, y.id);
            if candidate {
                let pair = score_pair(lang, x, y);
                pairs.entry((pair.lo, pair.hi)).or_insert(pair);
            }
        }
    }

    // Assign pairs best-first across the whole selection: a row-by-row greedy
    // match could pair two identical transfers a few minutes apart crosswise.
    let mut ranked: Vec<Pair> = pairs.into_values().collect();
    ranked.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(a.gap_secs.cmp(&b.gap_secs))
            .then(a.lo.cmp(&b.lo))
    });
    let mut used: HashSet<i64> = HashSet::new();
    let mut chosen: Vec<(Pair, usize)> = Vec::new();
    for p in &ranked {
        if used.contains(&p.lo) || used.contains(&p.hi) {
            continue;
        }
        let rivals = ranked
            .iter()
            .filter(|q| {
                (q.lo, q.hi) != (p.lo, p.hi)
                    && [q.lo, q.hi].iter().any(|id| *id == p.lo || *id == p.hi)
                    && q.score + 1 >= p.score
            })
            .count();
        used.insert(p.lo);
        used.insert(p.hi);
        chosen.push((p.clone(), rivals));
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (pair, rivals) in &chosen {
        let mut parts = pair.rationale_parts.clone();
        let mut confidence = pair.score;
        if *rivals > 0 {
            confidence -= 2;
            parts.push(match lang {
                Lang::Ru => format!("есть другие кандидаты с близкой оценкой ({rivals}) — проверьте пару"),
                Lang::En => format!("other candidates score almost as high ({rivals}) — check the pair"),
            });
        }
        let rationale = sentence(parts);
        let hash = pair_hash(pair.lo, pair.hi);
        // Recomputed sides may have pointed at other partners: drop those
        // stale halves so no transaction is left half of a vanished pair.
        tx.execute(
            "DELETE FROM transaction_suggestions
             WHERE kind = 'transfer' AND status = 'pending'
               AND (partner_txn_id IN (?1, ?2) OR transaction_id IN (?1, ?2))",
            params![pair.lo, pair.hi],
        )
        .map_err(|e| e.to_string())?;
        for (me, partner) in [(pair.lo, pair.hi), (pair.hi, pair.lo)] {
            upsert(
                &tx,
                &NewSuggestion {
                    transaction_id: me,
                    kind: KIND_TRANSFER,
                    source: "rule",
                    category_id: None,
                    partner_txn_id: Some(partner),
                    cash_account_id: None,
                    confidence,
                    rationale: &rationale,
                    input_hash: &hash,
                },
            )?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    summary.suggested = chosen.len() as i64;
    for id in eligible {
        if !used.contains(&id) {
            summary.skip("no_candidate");
        }
    }
    Ok(summary)
}

pub fn detect_transfers(
    state: State<'_, DbState>,
    transaction_ids: Vec<i64>,
    redo: bool,
) -> Result<RunSummary, String> {
    let mut conn = state.lock().map_err(|e| e.to_string())?;
    run_transfers(&mut conn, &transaction_ids, redo)
}

// ---------------------------------------------------------------------------
// Listing, applying, dismissing
// ---------------------------------------------------------------------------

/// Pending suggestions that still make sense: link suggestions for
/// transactions that got linked meanwhile, and category suggestions for
/// transactions that got categories, are left out.
#[cfg(test)]
pub(crate) fn list_pending_for_tests(conn: &Connection) -> Vec<Suggestion> {
    list_pending(conn).unwrap()
}

fn list_pending(conn: &Connection) -> Result<Vec<Suggestion>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.transaction_id, s.kind, s.source, s.category_id, s.partner_txn_id,
                    s.cash_account_id, s.confidence, s.rationale, s.reasoning, s.prompt,
                    s.model, s.created_at
             FROM transaction_suggestions s
             WHERE s.status = 'pending'
               AND NOT (s.kind IN ('transfer', 'cash_withdrawal') AND EXISTS (
                     SELECT 1 FROM transaction_links l
                      WHERE s.transaction_id IN (l.txn_a_id, l.txn_b_id)
                         OR s.partner_txn_id IN (l.txn_a_id, l.txn_b_id)))
               AND NOT (s.kind = 'category' AND EXISTS (
                     SELECT 1 FROM transaction_categories tc
                      WHERE tc.transaction_id = s.transaction_id))
             ORDER BY s.transaction_id, s.kind",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Suggestion {
                id: r.get(0)?,
                transaction_id: r.get(1)?,
                kind: r.get(2)?,
                source: r.get(3)?,
                category_id: r.get(4)?,
                partner_txn_id: r.get(5)?,
                cash_account_id: r.get(6)?,
                confidence: r.get(7)?,
                rationale: r.get(8)?,
                reasoning: r.get(9)?,
                prompt: r.get(10)?,
                model: r.get(11)?,
                created_at: r.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn list_transaction_suggestions(state: State<'_, DbState>) -> Result<Vec<Suggestion>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    list_pending(&conn)
}

struct Target {
    transaction_id: i64,
    kind: String,
    status: String,
    category_id: Option<i64>,
    partner_txn_id: Option<i64>,
    cash_account_id: Option<i64>,
    input_hash: String,
}

fn load_target(conn: &Connection, id: i64) -> Result<Target, String> {
    conn.query_row(
        "SELECT transaction_id, kind, status, category_id, partner_txn_id, cash_account_id, input_hash
         FROM transaction_suggestions WHERE id = ?1",
        [id],
        |r| {
            Ok(Target {
                transaction_id: r.get(0)?,
                kind: r.get(1)?,
                status: r.get(2)?,
                category_id: r.get(3)?,
                partner_txn_id: r.get(4)?,
                cash_account_id: r.get(5)?,
                input_hash: r.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| ERR_NOT_FOUND.to_string())
}

/// Set the status of a suggestion — for a transfer, of both halves.
fn set_status(conn: &Connection, id: i64, target: &Target, status: &str) -> Result<(), String> {
    if target.kind == KIND_TRANSFER {
        conn.execute(
            "UPDATE transaction_suggestions SET status = ?1
             WHERE kind = 'transfer' AND input_hash = ?2",
            params![status, target.input_hash],
        )
    } else {
        conn.execute(
            "UPDATE transaction_suggestions SET status = ?1 WHERE id = ?2",
            params![status, id],
        )
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Apply a suggestion through the regular command for its kind (which does
/// its own validation), then mark it accepted. The DB lock is released while
/// the delegated command runs — it takes the lock itself.
pub fn apply_suggestion(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let (target, debit, total, has_categories) = {
        let conn = state.lock().map_err(|e| e.to_string())?;
        let target = load_target(&conn, id)?;
        if target.status != "pending" {
            return Err(ERR_NOT_PENDING.to_string());
        }
        let (credit, debit): (i64, i64) = conn
            .query_row(
                "SELECT credit, debit FROM transactions WHERE id = ?1",
                [target.transaction_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        let has_categories: bool = conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM transaction_categories WHERE transaction_id = ?1)",
                [target.transaction_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        (target, debit, credit + debit, has_categories)
    };

    match target.kind.as_str() {
        KIND_CASH => {
            let cash_account_id = target.cash_account_id.ok_or(ERR_NOT_FOUND)?;
            crate::cash_withdrawals::create_cash_withdrawal(
                state,
                target.transaction_id,
                cash_account_id,
                money::format_minor(debit),
            )?;
        }
        KIND_TRANSFER => {
            let partner = target.partner_txn_id.ok_or(ERR_NOT_FOUND)?;
            crate::transaction_links::link_transactions(state, target.transaction_id, partner)?;
        }
        KIND_CATEGORY => {
            // Never overwrite the user's own categories.
            if has_categories {
                return Err(ERR_ALREADY_CATEGORIZED.to_string());
            }
            let category_id = target.category_id.ok_or(ERR_NOT_FOUND)?;
            crate::transaction_categories::set_transaction_categories(
                state,
                target.transaction_id,
                vec![crate::transaction_categories::CategoryItem {
                    category_id,
                    share_minor: total,
                    position: 0,
                }],
            )?;
        }
        _ => return Err(ERR_NOT_FOUND.to_string()),
    }

    let conn = state.lock().map_err(|e| e.to_string())?;
    set_status(&conn, id, &target, "accepted")?;
    if target.kind == KIND_CATEGORY {
        crate::category_agent::log_decision(&conn, true, id, target.transaction_id, target.category_id)?;
    }
    Ok(())
}

pub fn dismiss_suggestion(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let target = load_target(&conn, id)?;
    set_status(&conn, id, &target, "dismissed")?;
    if target.kind == KIND_CATEGORY {
        crate::category_agent::log_decision(&conn, false, id, target.transaction_id, target.category_id)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Context (what a model sees) and the reference-set export
// ---------------------------------------------------------------------------

/// Everything known about a transaction that a model may see. There is no
/// balance field, by design.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionContext {
    pub transaction_id: i64,
    pub account_id: i64,
    pub account: String,
    pub bank: String,
    pub account_kind: String,
    pub currency: String,
    pub occurred_at_utc: String,
    /// Wall time in the import batch's time zone, when known.
    pub occurred_at_local: Option<String>,
    /// `income` or `expense`.
    pub direction: String,
    pub amount: String,
    pub peer: Option<String>,
    pub bank_description: Option<String>,
    /// The user's own note.
    pub comment: Option<String>,
    /// Notes recognised on the linked slips.
    pub slip_notes: Vec<String>,
    /// What was going on in life that day (the Context screen).
    pub life_contexts: Vec<String>,
}

fn slip_notes(conn: &Connection, transaction_id: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT json_extract(extraction, '$.memo.value') FROM attachments
             WHERE transaction_id = ?1 ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let notes = stmt
        .query_map([transaction_id], |r| r.get::<_, Option<String>>(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(notes
        .into_iter()
        .flatten()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect())
}

fn local_datetime(f: &Facts) -> Option<DateTime<chrono::FixedOffset>> {
    let offset = f.timezone_offset.as_deref()?;
    let probe = DateTime::parse_from_rfc3339(&format!("2000-01-01T00:00:00{}", offset.trim())).ok()?;
    Some(f.at.with_timezone(probe.offset()))
}

fn local_time(f: &Facts) -> Option<String> {
    local_datetime(f).map(|t| t.to_rfc3339_opts(SecondsFormat::Secs, true))
}

/// The transaction's calendar day: in its import batch's time zone, else UTC.
fn local_day(f: &Facts) -> chrono::NaiveDate {
    local_datetime(f).map_or_else(|| f.at.date_naive(), |t| t.date_naive())
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

pub(crate) fn context_of(conn: &Connection, f: &Facts) -> Result<SuggestionContext, String> {
    Ok(SuggestionContext {
        transaction_id: f.id,
        account_id: f.account_id,
        account: f.account_label().to_string(),
        bank: f.bank.clone(),
        account_kind: f.account_kind.clone(),
        currency: f.currency.clone(),
        occurred_at_utc: f.occurred_at_utc.clone(),
        occurred_at_local: local_time(f),
        direction: if f.credit > 0 { "income" } else { "expense" }.to_string(),
        amount: money::format_minor(f.amount()),
        peer: non_empty(&f.peer),
        bank_description: non_empty(&f.bank_description),
        comment: non_empty(&f.comment),
        slip_notes: slip_notes(conn, f.id)?,
        life_contexts: crate::life_contexts::describe_day(conn, local_day(f))?,
    })
}

/// `id → "Parent / Child"` for every category.
pub(crate) fn category_paths(conn: &Connection) -> Result<Vec<(i64, String, String, Option<String>, Option<i64>)>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, kind, description, parent_id FROM categories ORDER BY kind, id")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(i64, String, String, Option<String>, Option<i64>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let by_id: HashMap<i64, (String, Option<i64>)> =
        rows.iter().map(|(id, name, _, _, parent)| (*id, (name.clone(), *parent))).collect();
    Ok(rows
        .iter()
        .map(|(id, _, kind, description, parent)| {
            let mut names = Vec::new();
            let mut cur = Some(*id);
            // Bounded walk: the UI caps the tree at three levels; the limit
            // only guards against a corrupted cycle.
            while let (Some(c), true) = (cur, names.len() < 16) {
                let Some((name, parent)) = by_id.get(&c) else { break };
                names.push(name.clone());
                cur = *parent;
            }
            names.reverse();
            (*id, names.join(" / "), kind.clone(), description.clone(), *parent)
        })
        .collect())
}

/// The selected transactions as a reference set for evaluating models and
/// rules: the exact context a model would get (no balance), the user's own
/// answer (categories, link partner), and every transaction on another
/// account within the transfer window (candidates for the pair rules).
fn build_reference_set(conn: &Connection, transaction_ids: &[i64]) -> Result<Value, String> {
    let all = load_all_facts(conn)?;
    let by_id: HashMap<i64, &Facts> = all.iter().map(|f| (f.id, f)).collect();
    let linked = linked_ids(conn)?;
    let paths = category_paths(conn)?;
    let path_of: HashMap<i64, &str> = paths.iter().map(|(id, p, ..)| (*id, p.as_str())).collect();

    let truth = |f: &Facts| -> Result<Value, String> {
        let mut stmt = conn
            .prepare(
                "SELECT category_id, share_minor FROM transaction_categories
                 WHERE transaction_id = ?1 ORDER BY position",
            )
            .map_err(|e| e.to_string())?;
        let categories: Vec<Value> = stmt
            .query_map([f.id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(id, share)| {
                json!({ "categoryId": id, "path": path_of.get(&id), "share": money::format_minor(share) })
            })
            .collect();
        let partner = linked.get(&f.id).copied();
        let link_kind = partner.and_then(|p| by_id.get(&p)).map(|p| {
            if p.account_kind == "cash" || f.account_kind == "cash" {
                KIND_CASH
            } else {
                KIND_TRANSFER
            }
        });
        Ok(json!({ "categories": categories, "linkedTxnId": partner, "linkKind": link_kind }))
    };

    let selection: HashSet<i64> = transaction_ids.iter().copied().collect();
    let mut transactions = Vec::new();
    let mut neighbor_ids: Vec<i64> = Vec::new();
    for id in transaction_ids {
        let Some(f) = by_id.get(id).copied() else { continue };
        transactions.push(json!({ "context": context_of(conn, f)?, "truth": truth(f)? }));
        for y in &all {
            if y.account_id != f.account_id
                && !selection.contains(&y.id)
                && !neighbor_ids.contains(&y.id)
                && (y.at - f.at).num_seconds().abs() <= TRANSFER_WINDOW_SECS
            {
                neighbor_ids.push(y.id);
            }
        }
    }
    let mut neighbors = Vec::new();
    for id in neighbor_ids {
        let f = by_id[&id];
        neighbors.push(json!({ "context": context_of(conn, f)?, "truth": truth(f)? }));
    }

    let mut stmt = conn
        .prepare("SELECT id, name, bank, kind, currency, account_number, owner_name FROM accounts ORDER BY id")
        .map_err(|e| e.to_string())?;
    let accounts: Vec<Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "name": r.get::<_, String>(1)?,
                "bank": r.get::<_, String>(2)?,
                "kind": r.get::<_, String>(3)?,
                "currency": r.get::<_, String>(4)?,
                "accountNumber": r.get::<_, Option<String>>(5)?,
                "ownerName": r.get::<_, Option<String>>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;

    let categories: Vec<Value> = paths
        .iter()
        .map(|(id, path, kind, description, parent)| {
            json!({ "id": id, "path": path, "kind": kind, "description": description, "parentId": parent })
        })
        .collect();

    Ok(json!({
        "meta": {
            "format": "a2b-reference-set",
            "version": 1,
            "exportedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            "appVersion": env!("CARGO_PKG_VERSION"),
            "transferWindowSecs": TRANSFER_WINDOW_SECS,
            "lifeDescription": crate::life_contexts::description(conn)?,
        },
        "categories": categories,
        "accounts": accounts,
        "transactions": transactions,
        "neighbors": neighbors,
    }))
}

pub fn export_reference_set(state: State<'_, DbState>, transaction_ids: Vec<i64>) -> Result<Value, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    build_reference_set(&conn, &transaction_ids)
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
    }

    impl Fx {
        fn new() -> Fx {
            let dir = TempDir::new().unwrap();
            let conn = db::open(dir.path()).unwrap();
            Fx { _dir: dir, state: Mutex::new(conn) }
        }

        fn account(&self, name: &str, kind: &str, currency: &str, number: Option<&str>) -> i64 {
            self.state
                .lock()
                .unwrap()
                .query_row(
                    "INSERT INTO accounts (name, kind, bank, currency, account_number, owner_name)
                     VALUES (?1, ?2, 'Bank', ?3, ?4, 'Ivan Petrov') RETURNING id",
                    params![name, kind, currency, number],
                    |r| r.get(0),
                )
                .unwrap()
        }

        /// A bank transaction (its own import batch at +07:00).
        fn txn(&self, account: i64, at: &str, credit: i64, debit: i64, description: &str) -> i64 {
            let conn = self.state.lock().unwrap();
            let batch: i64 = conn
                .query_row(
                    "INSERT INTO import_batches (account_id, imported_at, source_filename, row_count, timezone_offset)
                     VALUES (?1, '2026-05-20T10:00:00Z', NULL, 0, '+07:00') RETURNING id",
                    [account],
                    |r| r.get(0),
                )
                .unwrap();
            conn.query_row(
                "INSERT INTO transactions
                   (account_id, import_batch_id, occurred_at_utc, credit, debit, balance, bank_description)
                 VALUES (?1, ?2, ?3, ?4, ?5, 98765432, ?6) RETURNING id",
                params![account, batch, at, credit, debit, description],
                |r| r.get(0),
            )
            .unwrap()
        }

        fn pending(&self) -> Vec<Suggestion> {
            list_transaction_suggestions(&self.state).unwrap()
        }

        fn is_linked(&self, id: i64) -> bool {
            let conn = self.state.lock().unwrap();
            crate::transaction_links::is_already_linked(&conn, id).unwrap()
        }
    }

    #[test]
    fn atm_withdrawal_is_suggested_and_applied_as_new_cash_transaction() {
        let fx = Fx::new();
        let bank = fx.account("KBank", "bank", "THB", Some("123-4-56789-0"));
        let cash = fx.account("Wallet", "cash", "THB", None);
        let atm = fx.txn(bank, "2026-05-01T03:00:00.000Z", 0, 200_000, "Cash Withdrawal · ATM · Ref Code ATM4001");
        let other = fx.txn(bank, "2026-05-01T04:00:00.000Z", 0, 5_000, "Payment · K PLUS");

        let summary = detect_cash_withdrawals(&fx.state, vec![atm, other], false).unwrap();
        assert_eq!(summary.suggested, 1);
        assert_eq!(summary.skipped.get("no_signal"), Some(&1));
        let s = fx.pending();
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].kind.as_str(), s[0].cash_account_id), (KIND_CASH, Some(cash)));
        assert_eq!(s[0].confidence, 9);

        apply_suggestion(&fx.state, s[0].id).unwrap();
        assert!(fx.is_linked(atm));
        let credited: i64 = fx
            .state
            .lock()
            .unwrap()
            .query_row("SELECT credit FROM transactions WHERE account_id = ?1", [cash], |r| r.get(0))
            .unwrap();
        assert_eq!(credited, 200_000);
        assert!(fx.pending().is_empty());

        // Linked now — a second run skips it.
        let again = detect_cash_withdrawals(&fx.state, vec![atm], true).unwrap();
        assert_eq!(again.skipped.get("linked"), Some(&1));
    }

    #[test]
    fn atm_fee_and_atm_transfer_are_not_withdrawals() {
        let fx = Fx::new();
        let bank = fx.account("KBank", "bank", "THB", None);
        fx.account("Wallet", "cash", "THB", None);
        let fee = fx.txn(bank, "2026-05-01T03:00:00.000Z", 0, 2_000, "Fee · ATM · Ref Code ATM40014");
        let transfer = fx.txn(bank, "2026-05-01T03:10:00.000Z", 0, 9_000, "Transfer Withdrawal · ATM · To X1234");
        let summary = detect_cash_withdrawals(&fx.state, vec![fee, transfer], false).unwrap();
        assert_eq!(summary.suggested, 0);
        assert_eq!(summary.skipped.get("no_signal"), Some(&2));
    }

    #[test]
    fn cash_withdrawal_needs_a_cash_account_in_the_same_currency() {
        let fx = Fx::new();
        let bank = fx.account("KBank", "bank", "THB", None);
        fx.account("Wallet", "cash", "USD", None);
        let atm = fx.txn(bank, "2026-05-01T03:00:00.000Z", 0, 100, "ATM withdrawal");
        let summary = detect_cash_withdrawals(&fx.state, vec![atm], false).unwrap();
        assert_eq!(summary.suggested, 0);
        assert_eq!(summary.skipped.get("no_cash_account"), Some(&1));
    }

    #[test]
    fn dismissed_suggestion_is_not_offered_again() {
        let fx = Fx::new();
        let bank = fx.account("KBank", "bank", "THB", None);
        fx.account("Wallet", "cash", "THB", None);
        let atm = fx.txn(bank, "2026-05-01T03:00:00.000Z", 0, 100, "Cash Withdrawal · ATM");
        detect_cash_withdrawals(&fx.state, vec![atm], false).unwrap();
        dismiss_suggestion(&fx.state, fx.pending()[0].id).unwrap();
        assert!(fx.pending().is_empty());
        let again = detect_cash_withdrawals(&fx.state, vec![atm], true).unwrap();
        assert_eq!(again.skipped.get("dismissed"), Some(&1));
    }

    #[test]
    fn transfer_pair_by_amount_time_and_account_mask() {
        let fx = Fx::new();
        let kbank = fx.account("KBank", "bank", "THB", Some("123-4-56813-2"));
        let bbl = fx.account("BBL", "bank", "THB", Some("953-7-33021-4"));
        let out = fx.txn(kbank, "2026-05-01T03:00:00.000Z", 0, 100_000, "Transfer Withdrawal · K PLUS · To X3302 IVAN P");
        let inc = fx.txn(bbl, "2026-05-01T03:00:40.000Z", 100_000, 0, "Transfer Deposit · Internet/Mobile");
        // Same amount and direction, but half an hour later — never a candidate.
        fx.txn(bbl, "2026-05-01T03:30:00.000Z", 100_000, 0, "Transfer Deposit");

        let summary = detect_transfers(&fx.state, vec![out], false).unwrap();
        assert_eq!(summary.suggested, 1);
        let s = fx.pending();
        assert_eq!(s.len(), 2, "stored on both sides");
        let mine = s.iter().find(|x| x.transaction_id == out).unwrap();
        assert_eq!(mine.partner_txn_id, Some(inc));
        // 4 base + 2 (≤ 1 min) + 3 (mask) + 1 (transfer word) = 10.
        assert_eq!(mine.confidence, 10);
        assert!(mine.rationale.contains("3302"), "{}", mine.rationale);

        // Applying from the partner's side links the pair and closes both.
        let theirs = s.iter().find(|x| x.transaction_id == inc).unwrap();
        apply_suggestion(&fx.state, theirs.id).unwrap();
        assert!(fx.is_linked(out) && fx.is_linked(inc));
        assert!(fx.pending().is_empty());
    }

    #[test]
    fn transfer_window_is_five_minutes() {
        let fx = Fx::new();
        let a = fx.account("A", "bank", "THB", None);
        let b = fx.account("B", "bank", "THB", None);
        let out = fx.txn(a, "2026-05-01T03:00:00.000Z", 0, 500, "Transfer");
        fx.txn(b, "2026-05-01T03:05:01.000Z", 500, 0, "Transfer");
        let summary = detect_transfers(&fx.state, vec![out], false).unwrap();
        assert_eq!(summary.suggested, 0);
        assert_eq!(summary.skipped.get("no_candidate"), Some(&1));
    }

    #[test]
    fn identical_transfers_are_paired_by_closeness_not_by_row_order() {
        let fx = Fx::new();
        let a = fx.account("A", "bank", "THB", None);
        let b = fx.account("B", "bank", "THB", None);
        let out1 = fx.txn(a, "2026-05-01T03:00:00.000Z", 0, 1000, "");
        let out2 = fx.txn(a, "2026-05-01T03:03:00.000Z", 0, 1000, "");
        let in1 = fx.txn(b, "2026-05-01T03:00:30.000Z", 1000, 0, "");
        let in2 = fx.txn(b, "2026-05-01T03:03:30.000Z", 1000, 0, "");
        // Selection order puts out2 first; a row-by-row greedy pass would
        // happily take in1 (2.5 min away) for it.
        let summary = detect_transfers(&fx.state, vec![out2, out1], false).unwrap();
        assert_eq!(summary.suggested, 2);
        let partner = |id: i64| fx.pending().into_iter().find(|s| s.transaction_id == id).unwrap();
        assert_eq!(partner(out1).partner_txn_id, Some(in1));
        assert_eq!(partner(out2).partner_txn_id, Some(in2));
        // A near-equal rival lowers confidence and is mentioned.
        assert!(partner(out2).confidence < 6);
    }

    #[test]
    fn transfer_skips_linked_and_cash_pending() {
        let fx = Fx::new();
        let a = fx.account("A", "bank", "THB", None);
        let b = fx.account("B", "bank", "THB", None);
        fx.account("Wallet", "cash", "THB", None);
        let atm = fx.txn(a, "2026-05-01T03:00:00.000Z", 0, 1000, "Cash Withdrawal · ATM");
        fx.txn(b, "2026-05-01T03:00:10.000Z", 1000, 0, "");
        detect_cash_withdrawals(&fx.state, vec![atm], false).unwrap();
        let summary = detect_transfers(&fx.state, vec![atm], false).unwrap();
        assert_eq!(summary.skipped.get("cash_pending"), Some(&1));
    }

    #[test]
    fn reference_set_never_contains_the_balance() {
        let fx = Fx::new();
        let a = fx.account("A", "bank", "THB", None);
        let b = fx.account("B", "bank", "THB", None);
        let x = fx.txn(a, "2026-05-01T03:00:00.000Z", 0, 1000, "Payment");
        fx.txn(b, "2026-05-01T03:02:00.000Z", 1000, 0, "Neighbour");
        let conn = fx.state.lock().unwrap();
        let set = build_reference_set(&conn, &[x]).unwrap();
        let text = set.to_string();
        // Every row's balance is 98765432 minor units.
        assert!(!text.contains("987654"), "balance leaked: {text}");
        assert_eq!(set["transactions"].as_array().unwrap().len(), 1);
        assert_eq!(set["neighbors"].as_array().unwrap().len(), 1);
        assert_eq!(set["transactions"][0]["context"]["occurredAtLocal"], "2026-05-01T10:00:00+07:00");
    }

    #[test]
    fn context_carries_life_contexts_of_the_local_day() {
        let fx = Fx::new();
        let a = fx.account("A", "bank", "THB", None);
        // 2026-05-01T20:00Z is already 2 May at +07:00.
        let x = fx.txn(a, "2026-05-01T20:00:00.000Z", 0, 1000, "Toys");
        let conn = fx.state.lock().unwrap();
        conn.execute(
            "INSERT INTO life_contexts (title, starts_on, ends_on, color, note)
             VALUES ('Trip with the kids', '2026-05-02', '2026-05-05', '#57c8e0', 'Phuket')",
            [],
        )
        .unwrap();
        let set = build_reference_set(&conn, &[x]).unwrap();
        assert_eq!(set["transactions"][0]["context"]["lifeContexts"][0], "Trip with the kids — Phuket");
    }
}
