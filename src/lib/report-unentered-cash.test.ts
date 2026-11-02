import { describe, expect, it } from "vitest";

import { CashMetrics, SectionData } from "./api";
import { withUnenteredCash } from "./report-unentered-cash";

const expense: SectionData = {
  rows: [{ categoryId: null, name: "Uncategorized", color: "", depth: 0, values: ["10.00", "20.00"], total: "30.00" }],
  total: ["10.00", "20.00", "30.00"],
};
const cash = (currency: string, remaining: string[]): CashMetrics => ({ currency, received: [], remaining });

describe("withUnenteredCash", () => {
  it("adds a row under the existing ones and to the section total", () => {
    const shown = withUnenteredCash(expense, [cash("THB", ["5.50", "1.00"])], "Unentered cash");
    expect(shown.rows.map((r) => r.name)).toEqual(["Uncategorized", "Unentered cash, THB"]);
    expect(shown.rows[1]).toMatchObject({ categoryId: null, unenteredCash: true, values: ["5.50", "1.00"], total: "6.50" });
    expect(shown.total).toEqual(["15.50", "21.00", "36.50"]);
  });

  it("keeps negative periods, so the sum over periods still adds up", () => {
    const shown = withUnenteredCash(expense, [cash("THB", ["-4.00", "1.00"])], "Unentered cash");
    expect(shown.rows[1].total).toBe("-3.00");
    expect(shown.total).toEqual(["6.00", "21.00", "27.00"]);
  });

  it("gives each currency its own row", () => {
    const shown = withUnenteredCash(expense, [cash("THB", ["1.00", "0.00"]), cash("USD", ["2.00", "0.00"])], "Unentered cash");
    expect(shown.rows.slice(1).map((r) => r.name)).toEqual(["Unentered cash, THB", "Unentered cash, USD"]);
  });

  it("leaves the section alone without cash accounts", () => {
    expect(withUnenteredCash(expense, [], "Unentered cash")).toBe(expense);
  });
});
