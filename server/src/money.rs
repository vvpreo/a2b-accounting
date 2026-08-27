use std::str::FromStr;

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;

pub const SCALE: u32 = 2;

#[derive(Debug, thiserror::Error)]
pub enum MoneyError {
    #[error("invalid number format: {0}")]
    InvalidFormat(String),
    #[error("value has too many decimal places (max {SCALE}): {0}")]
    TooManyDecimals(String),
    #[error("value out of range for i64: {0}")]
    Overflow(String),
}

pub fn parse_minor(s: &str) -> Result<i64, MoneyError> {
    let trimmed = s.trim();
    let normalized = normalize_number(trimmed);
    let d = Decimal::from_str(&normalized)
        .map_err(|_| MoneyError::InvalidFormat(s.to_string()))?;
    let multiplier = Decimal::from(10_i64.pow(SCALE));
    let scaled = d * multiplier;
    if !scaled.fract().is_zero() {
        return Err(MoneyError::TooManyDecimals(s.to_string()));
    }
    scaled
        .to_i64()
        .ok_or_else(|| MoneyError::Overflow(s.to_string()))
}

/// Accept human-friendly thousands-grouped numbers in addition to plain decimals.
///   "1,234,567.89"  -> "1234567.89"   (US/UK/Thai: comma = thousands)
///   "1.234.567,89"  -> "1234567.89"   (EU: dot = thousands, comma = decimal)
///   "1,234"         -> "1234"         (looks like thousands grouping)
///   "342,44"        -> "342.44"       (only comma, not at thousands position -> decimal)
///   "123.45"        -> "123.45"       (untouched)
fn normalize_number(s: &str) -> String {
    let has_dot = s.contains('.');
    let has_comma = s.contains(',');
    if !has_comma {
        return s.to_string();
    }
    if has_dot {
        let last_dot = s.rfind('.').unwrap();
        let last_comma = s.rfind(',').unwrap();
        if last_dot > last_comma {
            // US/UK/Thai: 1,234,567.89
            return s.replace(',', "");
        }
        // EU: 1.234.567,89
        return s.replace('.', "").replacen(',', ".", 1).replace(',', "");
    }
    // Only commas, no dot. Decide via grouping heuristic.
    if looks_like_thousands_grouped(s) {
        s.replace(',', "")
    } else {
        // Single trailing group that is not 3 digits -> treat comma as decimal.
        s.replacen(',', ".", 1).replace(',', "")
    }
}

fn looks_like_thousands_grouped(s: &str) -> bool {
    let core = s.trim_start_matches(|c: char| c == '+' || c == '-');
    let parts: Vec<&str> = core.split(',').collect();
    if parts.len() < 2 {
        return false;
    }
    if parts[0].is_empty() || parts[0].len() > 3 {
        return false;
    }
    if !parts[0].chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    parts[1..]
        .iter()
        .all(|p| p.len() == 3 && p.chars().all(|c| c.is_ascii_digit()))
}

pub fn format_minor(n: i64) -> String {
    Decimal::new(n, SCALE).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple() {
        assert_eq!(parse_minor("123.45").unwrap(), 12345);
        assert_eq!(parse_minor("0.01").unwrap(), 1);
        assert_eq!(parse_minor("0").unwrap(), 0);
        assert_eq!(parse_minor("100").unwrap(), 10000);
        assert_eq!(parse_minor("-5.00").unwrap(), -500);
    }

    #[test]
    fn parses_trimmed() {
        assert_eq!(parse_minor("  42.00  ").unwrap(), 4200);
    }

    #[test]
    fn rejects_too_many_decimals() {
        assert!(matches!(
            parse_minor("1.234"),
            Err(MoneyError::TooManyDecimals(_))
        ));
    }

    #[test]
    fn rejects_garbage() {
        assert!(matches!(
            parse_minor("abc"),
            Err(MoneyError::InvalidFormat(_))
        ));
        assert!(matches!(parse_minor(""), Err(MoneyError::InvalidFormat(_))));
    }

    #[test]
    fn formats_correctly() {
        assert_eq!(format_minor(12345), "123.45");
        assert_eq!(format_minor(1), "0.01");
        assert_eq!(format_minor(0), "0.00");
        assert_eq!(format_minor(-500), "-5.00");
        assert_eq!(format_minor(10000), "100.00");
    }

    #[test]
    fn roundtrip() {
        for &s in &["0.00", "1.23", "12345.67", "-9.99", "0.01"] {
            let minor = parse_minor(s).unwrap();
            assert_eq!(format_minor(minor), s);
        }
    }

    #[test]
    fn parses_us_thousands_separator() {
        assert_eq!(parse_minor("1,234.56").unwrap(), 123456);
        assert_eq!(parse_minor("342,231.44").unwrap(), 34223144);
        assert_eq!(parse_minor("1,508,833.86").unwrap(), 150883386);
        assert_eq!(parse_minor("25,000.00").unwrap(), 2500000);
        assert_eq!(parse_minor("-1,234.56").unwrap(), -123456);
    }

    #[test]
    fn parses_eu_decimal_comma() {
        assert_eq!(parse_minor("342,44").unwrap(), 34244);
        assert_eq!(parse_minor("1.234,56").unwrap(), 123456);
        assert_eq!(parse_minor("1.234.567,89").unwrap(), 123456789);
    }

    #[test]
    fn comma_only_thousands_grouped_strips() {
        assert_eq!(parse_minor("1,234").unwrap(), 123400);
        assert_eq!(parse_minor("12,345").unwrap(), 1234500);
    }

    #[test]
    fn rejects_garbage_with_separators() {
        assert!(parse_minor(",,123").is_err());
        assert!(parse_minor("1,2,3,4").is_err());
    }
}
