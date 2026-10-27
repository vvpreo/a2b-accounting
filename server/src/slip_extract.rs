//! Field extractors over recognised (OCR) document text.
//!
//! Each extractor is independent and layout-agnostic: it looks for meaning
//! (labels, value formats) anywhere in the text rather than at fixed
//! positions, so a new slip design or another bank does not need new code.
//! Every function may come up empty — callers treat each field as optional.
//!
//! OCR of mixed-script slips routinely swaps Latin letters for Cyrillic
//! look-alikes (`ххх-х-х6813-х`, `11:58 РМ`). Structured fields (dates,
//! account masks) are read from a [`latinize`]d copy; the memo is read from
//! the original text, because it is often written in Russian.

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
        r"(?i)\b(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{2}|\d{4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?[ \t]*(am|pm)?\b",
    );
    for c in date.captures_iter(text) {
        let Some(month) = MONTHS.iter().position(|m| c[2].eq_ignore_ascii_case(m)) else {
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

/// Text after a note label (`Memo:`, `Note`, `Remark`, `Заметка`,
/// `บันทึกช่วยจำ`) up to the next known label or the end of the block.
fn memo(text: &str) -> Option<String> {
    static LABEL: OnceLock<Regex> = OnceLock::new();
    static STOP: OnceLock<Regex> = OnceLock::new();
    let label = re(
        &LABEL,
        r"(?i)^\s*(?:memo|note|remark|заметка|комментарий|บันทึกช่วยจำ)\s*[:：]?\s*(.*)$",
    );
    let stop = re(
        &STOP,
        r"(?i)^\s*(bank reference|transaction reference|transaction id|reference no|scan|amount|fee)\b",
    );
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.iter().position(|l| label.is_match(l))?;
    let mut parts: Vec<String> = Vec::new();
    let first = label.captures(lines[start])?[1].trim().to_string();
    if !first.is_empty() {
        parts.push(first);
    }
    for line in &lines[start + 1..] {
        let line = line.trim();
        if line.is_empty() {
            if parts.is_empty() {
                continue;
            }
            break;
        }
        if stop.is_match(line) {
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

    /// K PLUS slip as Tesseract reads it (names replaced), incl. the usual
    /// OCR noise: Cyrillic `ххх`, `O` for `0`, a garbled `Baht`.
    const KPLUS: &str = "Payment Completed
๑ 27 Oct 26 11:58 AM K+

MR. TEST P

KBank
ง ххх-х-х1234-х

๐ DEPARTMENT OF
HIGHWAY, M-FLOW

PAYMENT
326102700000015842

Amount:

360.00 sant п

0.00 Baht У
oe

Transaction ID: Sean for
016300115855CPMO9866 Verify Slip

Fee:

Memo: штраф за неоплату своевременную платной
дороги в Бангкоке
";

    /// Older K PLUS layout (Transaction ID above Amount), PM read as Cyrillic.
    const KPLUS_OLD: &str = "| Payment Completed |<
7 Feb 25 5:58 РМ =

MR. TEST P
KBank

ххх-х-х1234-х
SURINSHOP

Transaction ID:

015038175808APM06920
Amount:
210.00 Baht
0.00 Baht Scan for Verify Slip

Memo: bike fuel
";

    /// Bangkok Bank slip (24-hour clock, `Note` on the same line).
    const BBL: &str = "(©) Bangkok Bank

Transaction successful

04 Feb 25, 15:23

Amount

16,632.00 THB

From MR TEST
953-7-xxx999
Bangkok Bank

To OAK MEADOW IN
435-0-xxx855
Siam Commercial Bank

Fee 0.00 THB

Note OMIS venya feb

Bank reference no.
366496
Transaction reference
2025020415232024009442308
";

    #[test]
    fn kplus_slip() {
        let f = extract(KPLUS);
        assert_eq!(f.occurred_at, Some(dt("2026-10-27 11:58:00")));
        assert_eq!(f.amount_minor, Some(36000));
        assert_eq!(f.direction, Some("debit"));
        assert_eq!(f.account_mask.as_deref(), Some("xxx-x-x1234-x"));
        assert_eq!(
            f.memo.as_deref(),
            Some("штраф за неоплату своевременную платной дороги в Бангкоке")
        );
    }

    #[test]
    fn kplus_old_layout_with_cyrillic_pm() {
        let f = extract(KPLUS_OLD);
        assert_eq!(f.occurred_at, Some(dt("2025-02-07 17:58:00")));
        assert_eq!(f.amount_minor, Some(21000));
        assert_eq!(f.memo.as_deref(), Some("bike fuel"));
    }

    #[test]
    fn bangkok_bank_slip() {
        let f = extract(BBL);
        assert_eq!(f.occurred_at, Some(dt("2025-02-04 15:23:00")));
        assert_eq!(f.amount_minor, Some(1_663_200));
        assert!(f.all_amounts_minor.contains(&1_663_200));
        assert_eq!(f.account_mask.as_deref(), Some("953-7-xxx999"));
        assert_eq!(f.memo.as_deref(), Some("OMIS venya feb"));
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
