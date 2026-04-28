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
