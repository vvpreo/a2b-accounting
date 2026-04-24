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
    let d = Decimal::from_str(trimmed).map_err(|_| MoneyError::InvalidFormat(s.to_string()))?;
    let multiplier = Decimal::from(10_i64.pow(SCALE));
    let scaled = d * multiplier;
    if !scaled.fract().is_zero() {
        return Err(MoneyError::TooManyDecimals(s.to_string()));
    }
    scaled
        .to_i64()
        .ok_or_else(|| MoneyError::Overflow(s.to_string()))
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
}
