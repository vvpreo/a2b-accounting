import { AccountBalances } from "./api";
import { parseMoneyToMinor } from "./money";

export type BalanceMetric = "opening" | "closing";

export interface BalanceBreakdownRow {
  accountId: number;
  amount: string;
  /** The day of the transaction this balance comes from; null if none yet. */
  asOf: string | null;
}

/** What one balance cell of the report is made of: the accounts in the order
 *  given (the owner's), and their sum, which is the number in the cell. */
export function balanceBreakdown(
  byAccount: AccountBalances[],
  metric: BalanceMetric,
  periodIndex: number,
  accountOrder: number[],
): { rows: BalanceBreakdownRow[]; totalMinor: number } {
  const position = new Map(accountOrder.map((id, i) => [id, i]));
  const rank = (id: number) => position.get(id) ?? accountOrder.length;
  const rows = [...byAccount]
    .sort((a, b) => rank(a.accountId) - rank(b.accountId) || a.accountId - b.accountId)
    .map((a) => ({
      accountId: a.accountId,
      amount: (metric === "opening" ? a.opening : a.closing)[periodIndex] ?? "0.00",
      asOf: (metric === "opening" ? a.openingAsOf : a.closingAsOf)[periodIndex] ?? null,
    }));
  return { rows, totalMinor: rows.reduce((sum, r) => sum + (parseMoneyToMinor(r.amount) ?? 0), 0) };
}
