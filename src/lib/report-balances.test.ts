import { describe, expect, it } from "vitest";

import { AccountBalances } from "./api";
import { balanceBreakdown } from "./report-balances";

const account = (accountId: number, opening: string[], closing: string[]): AccountBalances => ({
  accountId,
  opening,
  closing,
  openingAsOf: opening.map((_, i) => (i === 0 ? null : "2026-01-31")),
  closingAsOf: closing.map(() => "2026-01-31"),
});

const data = [account(1, ["0.00", "100.50"], ["100.50", "90.00"]), account(2, ["0.00", "-20.00"], ["-20.00", "-5.25"])];

describe("balanceBreakdown", () => {
  it("takes the metric and the period, and sums to the cell", () => {
    const closing = balanceBreakdown(data, "closing", 1, [1, 2]);
    expect(closing.rows.map((r) => r.amount)).toEqual(["90.00", "-5.25"]);
    expect(closing.totalMinor).toBe(8475);
    const opening = balanceBreakdown(data, "opening", 1, [1, 2]);
    expect(opening.rows.map((r) => r.amount)).toEqual(["100.50", "-20.00"]);
    expect(opening.totalMinor).toBe(8050);
  });

  it("carries the day the balance comes from, or null if there was none", () => {
    expect(balanceBreakdown(data, "opening", 0, [1, 2]).rows[0].asOf).toBeNull();
    expect(balanceBreakdown(data, "opening", 1, [1, 2]).rows[0].asOf).toBe("2026-01-31");
  });

  it("keeps the owner's order of accounts, unknown ones last", () => {
    const three = [...data, account(3, ["0.00", "0.00"], ["0.00", "0.00"])];
    expect(balanceBreakdown(three, "closing", 0, [2, 1]).rows.map((r) => r.accountId)).toEqual([2, 1, 3]);
  });
});
