//! Field extractors over recognised (OCR) document text.
//!
//! Each extractor is independent and layout-agnostic: it looks for meaning
//! (labels, value formats) anywhere in the text rather than at fixed
//! positions, so a new slip design or another bank does not need new code.
//! Every function may come up empty — callers treat each field as optional.
//!
//! Input is the layout-aware text from `ocr.rs`: one line per visual line,
//! `" | "` where there is a wide gap (typically label | value).
//!
//! OCR of mixed-script slips can swap Latin letters for Cyrillic look-alikes
//! (`Мето` for `Memo`, `ххх-х-х6813-х`). Structured fields (dates, account
//! masks) are read from a [`latinize`]d copy and labels are matched fuzzily;
//! the memo text itself is read from the original, because it is often
//! written in Russian.

use std::sync::OnceLock;

use chrono::{NaiveDate, NaiveDateTime};
use regex::Regex;
use serde::Serialize;

/// What the extractors found in one document's text.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFields {
    /// Wall time printed on the document (no zone).
    pub occurred_at: Option<NaiveDateTime>,
    /// The document's main amount, minor units.
    pub amount_minor: Option<i64>,
    /// Every money amount found in the text, minor units (for verification
    /// against a candidate transaction when the main amount is unsure).
    pub all_amounts_minor: Vec<i64>,
    /// `"debit"` (money left the account) or `"credit"`.
    pub direction: Option<&'static str>,
    /// Masked account number as printed (`xxx-x-x6813-x`).
    pub account_mask: Option<String>,
    /// The user's note on the document.
    pub memo: Option<String>,
    /// Sending bank and transaction reference — only the LLM recogniser
    /// reports these (the local pipeline reads them from the slip QR).
    pub bank: Option<String>,
    pub reference: Option<String>,
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

/// Replace Cyrillic letters that OCR confuses with Latin ones.
pub fn latinize(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'А' => 'A',
            'В' => 'B',
            'Е' => 'E',
            'К' => 'K',
            'М' => 'M',
            'Н' => 'H',
            'О' => 'O',
            'Р' => 'P',
            'С' => 'C',
            'Т' => 'T',
            'Х' => 'X',
            'а' => 'a',
            'е' => 'e',
            'о' => 'o',
            'р' => 'p',
            'с' => 'c',
            'у' => 'y',
            'х' => 'x',
            other => other,
        })
        .collect()
}

pub fn extract(text: &str) -> TextFields {
    let latin = latinize(text);
    let all_amounts_minor = money_amounts(&latin);
    TextFields {
        occurred_at: occurred_at(&latin),
        amount_minor: main_amount(&latin),
        all_amounts_minor,
        direction: direction(&latin),
        account_mask: account_mask(&latin),
        memo: memo(text),
        bank: None,
        reference: None,
    }
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// `27 Oct 26 11:58 AM`, `04 Feb 25, 15:23`, `7 Feb 2025 5:58:12 PM`; a
/// Buddhist-era year (2568) is converted.
fn occurred_at(text: &str) -> Option<NaiveDateTime> {
    static DATE: OnceLock<Regex> = OnceLock::new();
    let date = re(
        &DATE,
        r"(?i)(?:^|[^\d])(\d{1,2})\s*([a-z0]{3})[a-z]*\.?\s*(\d{2}|\d{4})(?:,\s*|\s+)(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?[ \t]*(am|pm)?\b",
    );
    for c in date.captures_iter(text) {
        // OCR reads "Oct" as "0ct" now and then.
        let month_name = c[2].to_lowercase().replace('0', "o");
        let Some(month) = MONTHS.iter().position(|m| month_name == *m) else {
            continue;
        };
        let mut year: i32 = c[3].parse().ok()?;
        if year < 100 {
            year += 2000;
        }
        if year > 2400 {
            year -= 543;
        }
        let mut hour: u32 = c[4].parse().ok()?;
        if let Some(ampm) = c.get(7) {
            hour %= 12;
            if ampm.as_str().eq_ignore_ascii_case("pm") {
                hour += 12;
            }
        }
        let minute: u32 = c[5].parse().ok()?;
        let second: u32 = c.get(6).map_or(Some(0), |s| s.as_str().parse().ok())?;
        let found = NaiveDate::from_ymd_opt(year, month as u32 + 1, c[1].parse().ok()?)
            .and_then(|d| d.and_hms_opt(hour, minute, second));
        if found.is_some() {
            return found;
        }
    }
    None
}

/// Money tokens `16,632.00` / `360.00` in reading order, minor units.
fn money_amounts(text: &str) -> Vec<i64> {
    static MONEY: OnceLock<Regex> = OnceLock::new();
    let money = re(&MONEY, r"(?:^|[^\d.,])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?:[^\d]|$)");
    money
        .captures_iter(text)
        .filter_map(|c| {
            let whole: i64 = c[1].replace(',', "").parse().ok()?;
            let cents: i64 = c[2].parse().ok()?;
            Some(whole * 100 + cents)
        })
        .collect()
}

/// The amount next to an amount label (`Amount`, `Total`, `Сумма`,
/// `จำนวนเงิน`) — on the label's line or the next couple of lines; otherwise
/// the largest non-zero amount in the text (fees are usually zero/small).
fn main_amount(text: &str) -> Option<i64> {
    static LABEL: OnceLock<Regex> = OnceLock::new();
    let label = re(&LABEL, r"(?i)\b(amount|total|сумма)\b|จำนวน");
    let lines: Vec<&str> = text.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if !label.is_match(line) {
            continue;
        }
        for near in lines.iter().skip(i).take(3) {
            if let Some(&a) = money_amounts(near).iter().find(|&&a| a > 0) {
                return Some(a);
            }
        }
    }
    money_amounts(text).into_iter().filter(|&a| a > 0).max()
}

fn direction(text: &str) -> Option<&'static str> {
    static CREDIT: OnceLock<Regex> = OnceLock::new();
    static DEBIT: OnceLock<Regex> = OnceLock::new();
    let credit = re(&CREDIT, r"(?i)\b(received|deposit|incoming|refund)\b|รับเงิน|поступлен|зачислен");
    let debit = re(
        &DEBIT,
        r"(?i)\b(payment|paid|transfer|withdrawal|purchase)\b|โอนเงิน|ชำระ|оплат|перевод|списан",
    );
    if credit.is_match(text) {
        Some("credit")
    } else if debit.is_match(text) {
        Some("debit")
    } else {
        None
    }
}

/// A masked account number: `xxx-x-x6813-x`, `953-7-xxx734`, `****1234`.
fn account_mask(text: &str) -> Option<String> {
    static MASK: OnceLock<Regex> = OnceLock::new();
    let mask = re(
        &MASK,
        r"(?i)\b(?:[x\d]{3}-[x\d]-[x\d]{5}-[x\d]|\d{3}-\d-x{3}\d{3}|[x\d]{3}-[x\d]{3}-\d{4})\b|\*{2,}\d{3,4}\b",
    );
    mask.find(text).map(|m| m.as_str().to_lowercase())
}

/// Levenshtein distance (labels are short — a tiny DP is plenty).
fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1];
        for (j, &cb) in b.iter().enumerate() {
            cur.push((prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + usize::from(ca != cb)));
        }
        prev = cur;
    }
    prev[b.len()]
}

const MEMO_LABELS: [&str; 5] = ["memo", "note", "remark", "заметка", "комментарий"];

/// If `line` starts with a note label (fuzzy: one typo or a Cyrillic
/// look-alike allowed), return the rest of the line after it.
fn after_memo_label(line: &str) -> Option<&str> {
    let line = line.trim_start();
    let end = line
        .find(|c: char| c.is_whitespace() || c == ':' || c == '：' || c == '|')
        .unwrap_or(line.len());
    let word = latinize(&line[..end]).to_lowercase();
    let is_label = word == "บันทึกช่วยจำ"
        || (word.chars().count() >= 3 && MEMO_LABELS.iter().any(|l| edit_distance(&word, l) <= 1));
    is_label.then(|| line[end..].trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ':' | '：' | '|')))
}

/// Text after a note label (`Memo:`, `Note | …`, `Remark`, `Заметка`,
/// `บันทึกช่วยจำ`), continued over the following lines until the next field:
/// a known footer label, another `label | value` line, or an empty line.
fn memo(text: &str) -> Option<String> {
    static STOP: OnceLock<Regex> = OnceLock::new();
    let stop = re(
        &STOP,
        r"(?i)^\s*(bank reference|transaction reference|transaction id|reference no|ref\.? no|scan|amount|fee|from|to)\b",
    );
    // Footer labels end a memo wherever they appear in a line (OCR may glue
    // the reference number in front: "391380 Bank reference no.").
    static FOOTER: OnceLock<Regex> = OnceLock::new();
    let footer = re(&FOOTER, r"(?i)\b(bank reference|transaction reference|reference no|scan to verify)\b");
    let lines: Vec<&str> = text.lines().collect();
    let (start, first) = lines.iter().enumerate().find_map(|(i, l)| after_memo_label(l).map(|rest| (i, rest)))?;
    let mut parts: Vec<String> = Vec::new();
    if !first.trim().is_empty() {
        parts.push(first.trim().to_string());
    }
    for line in lines[start + 1..].iter().take(4) {
        let line = line.trim();
        if line.is_empty() {
            if parts.is_empty() {
                continue;
            }
            break;
        }
        if stop.is_match(line) || footer.is_match(line) || line.contains(" | ") {
            break;
        }
        parts.push(line.to_string());
    }
    let memo = parts.join(" ").trim().to_string();
    (!memo.is_empty()).then_some(memo)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    /// K PLUS slip as PaddleOCR + layout reads it (names/accounts replaced).
    /// The memo line was read by the Cyrillic model, so its label came out as
    /// Cyrillic "Мето".
    const KPLUS: &str = "7 Jun 26 10:17 AM Payment Completed | K+
MR. TEST P
KBank
XXX-X-x1234-X
SCB มณี SHOP (MY NAMEIS YOO)
แm | 014000007441876
SCB
Transaction ID:
016158101719CPM05020
Amount:
100.00Baht
Fee:
0.00Baht Scan for Verify Slip
Мето: кофе на спартане";

    /// Older K PLUS layout (Transaction ID above Amount), Latin memo.
    const KPLUS_OLD: &str = "Payment Completed 7 Feb 25 5:58 PM | K+
MR. TEST P
KBank
XXX-X-x1234-X
ร้านถุงเงิน (สุรินทร์ ของชำ)
川 | 2338207053016041559
SURINSHOP
Transaction ID:
015038175808APM06920
Amount:
210.00Baht
Fee:
0.00Baht Scan for Verify Slip
Memo: bike fuel";

    /// Bangkok Bank: label | value columns, a note wrapped over two lines,
    /// no space after the comma in the date.
    const BBL: &str = "Bangkok Bank
Transaction successful
01Aug 25,14:20
Amount
15,000.00 THB
From | MR TEST
953-7-xxx999
Bangkok Bank
To | BITKUB ONLINE
Biller ID:010555911712807
REFERENCE 1
TESTREFERENCE
REFERENCE 2 (Optional)
THBDP0024923891
Fee | 0.00 THB
Note | Для августовских платежей по
сториджару
Bank reference no.
316533
Transaction r reference
2025080114200723009096908
Scan to verify";

    /// Bangkok Bank slip without a note.
    const BBL_NO_NOTE: &str = "Bangkok Bank
Transaction successful
Amount
10,000.00 THB
From | MR TEST
953-7-xxx999
Bangkok Bank
To | MRS. TEST
143-8-xxx302
Kasikornbank
Fee | 0.00 THB
Bank reference no.
602867
Scan to verify";

    #[test]
    fn kplus_slip() {
        let f = extract(KPLUS);
        assert_eq!(f.occurred_at, Some(dt("2026-06-07 10:17:00")));
        assert_eq!(f.amount_minor, Some(10000));
        assert_eq!(f.direction, Some("debit"));
        assert_eq!(f.account_mask.as_deref(), Some("xxx-x-x1234-x"));
        assert_eq!(f.memo.as_deref(), Some("кофе на спартане"));
    }

    #[test]
    fn kplus_old_layout() {
        let f = extract(KPLUS_OLD);
        assert_eq!(f.occurred_at, Some(dt("2025-02-07 17:58:00")));
        assert_eq!(f.amount_minor, Some(21000));
        assert_eq!(f.memo.as_deref(), Some("bike fuel"));
    }

    #[test]
    fn bangkok_bank_slip() {
        let f = extract(BBL);
        assert_eq!(f.occurred_at, Some(dt("2025-08-01 14:20:00")));
        assert_eq!(f.amount_minor, Some(1_500_000));
        assert_eq!(f.account_mask.as_deref(), Some("953-7-xxx999"));
        assert_eq!(f.memo.as_deref(), Some("Для августовских платежей по сториджару"));
        assert_eq!(extract(BBL_NO_NOTE).memo, None);
    }

    #[test]
    fn memo_labels_are_fuzzy() {
        assert_eq!(after_memo_label("Note | OMIS venya feb"), Some("OMIS venya feb"));
        assert_eq!(after_memo_label("Мето: латте"), Some("латте"));
        assert_eq!(after_memo_label("Memо: x"), Some("x"), "Cyrillic о inside");
        assert_eq!(after_memo_label("Nate: typo"), Some("typo"), "one typo");
        assert_eq!(after_memo_label("Notebook"), None);
        assert_eq!(after_memo_label("Total"), None);
        assert_eq!(after_memo_label("No"), None, "too short to be fuzzy");
    }

    #[test]
    fn russian_memo_is_not_latinized() {
        let f = extract("Amount: 55.00 Baht\nMemo: латте Насте\n");
        assert_eq!(f.memo.as_deref(), Some("латте Насте"));
    }

    #[test]
    fn missing_fields_stay_empty() {
        // Direction is only a hint (keywords); the match against a
        // transaction is what confirms it, so neutral text must stay empty.
        let f = extract("Scan QR\nName: MR. TEST\n");
        assert_eq!(f, TextFields::default());
    }

    #[test]
    fn buddhist_year_and_seconds() {
        assert_eq!(
            occurred_at("วันที่ 3 Mar 2568 09:05:07"),
            Some(dt("2025-03-03 09:05:07"))
        );
    }
}
