/**
 * Format a money amount produced by the Rust side ("12345.67", "-9.99",
 * "0.00") with thin-space thousands separators for readability:
 *   "12345.67"   -> "12 345.67"
 *   "1234567.89" -> "1 234 567.89"
 *   "-1500.00"   -> "-1 500.00"
 *   "0.00"       -> "0.00"
 * Strings that don't match the expected shape are returned untouched.
 */
export function formatMoney(s: string | null | undefined): string {
  if (s === null || s === undefined || s === "") return "";
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!match) return s;
  const [, sign, intPart, decPart] = match;
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return sign + grouped + (decPart ? "." + decPart : "");
}

// Convert minor units (kopecks, scale 2) to a "123.45"-style string.
export function formatMinorAsMoney(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const major = Math.trunc(abs / 100);
  const cents = abs % 100;
  return `${sign}${major}.${cents.toString().padStart(2, "0")}`;
}

// Parse a user-entered money string ("123,45", "1 234.50", "0.5") to minor units.
// Returns null on invalid input. Trims whitespace, accepts both "." and "," as the
// decimal separator and ignores spaces.
export function parseMoneyToMinor(s: string): number | null {
  const trimmed = s.trim().replace(/\s+/g, "").replace(",", ".");
  if (trimmed === "") return null;
  const match = /^(-?)(\d+)(?:\.(\d{0,2}))?$/.exec(trimmed);
  if (!match) return null;
  const [, sign, intPart, decPart = ""] = match;
  const cents = (decPart + "00").slice(0, 2);
  const value = parseInt(intPart, 10) * 100 + parseInt(cents, 10);
  return sign === "-" ? -value : value;
}
