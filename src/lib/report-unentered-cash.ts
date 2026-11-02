import { CashMetrics, ReportRow, SectionData } from "./api";
import { formatMinorAsMoney, parseMoneyToMinor } from "./money";

const toMinor = (value: string) => parseMoneyToMinor(value) ?? 0;

/**
 * The expense section with cash not entered as transactions added to it: one
 * row per currency, taken from the "Cash remaining" metric. Only a view of the
 * report, so that the expense total and the net result count that cash as
 * spent; a negative value (older cash spent this period) has to stay, or the
 * sum over periods would not add up.
 */
export function withUnenteredCash(
  expense: SectionData,
  cash: CashMetrics[],
  label: string,
): SectionData {
  if (cash.length === 0) return expense;
  const rows: ReportRow[] = cash.map(({ currency, remaining }) => ({
    categoryId: null,
    unenteredCash: true,
    name: `${label}, ${currency}`,
    color: "",
    depth: 0,
    values: remaining,
    total: formatMinorAsMoney(remaining.reduce((sum, v) => sum + toMinor(v), 0)),
  }));
  // The section's `total` runs one past the periods: its last entry is the
  // total over all of them.
  const total = expense.total.map((value, i) =>
    formatMinorAsMoney(rows.reduce((sum, row) => sum + toMinor(row.values[i] ?? row.total), toMinor(value))),
  );
  return { rows: [...expense.rows, ...rows], total };
}
