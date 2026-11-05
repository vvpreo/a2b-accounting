import { describe, expect, it } from "vitest";

import { WaterfallColumn } from "./report-waterfall";
import { buildWaterfallSheet, WaterfallSheetLabels } from "./waterfall-xlsx";

const column = (key: string, kind: WaterfallColumn["kind"], startMinor: number, endMinor: number): WaterfallColumn => ({
  key,
  kind,
  categoryId: null,
  deltaMinor: kind === "opening" || kind === "closing" ? endMinor : endMinor - startMinor,
  startMinor,
  endMinor,
});

const COLUMNS = [
  column("opening", "opening", 0, 100000),
  column("income", "income", 100000, 150050),
  column("other", "other", 150050, 120000),
  column("closing", "closing", 0, 120000),
];

const LABELS: WaterfallSheetLabels = {
  title: "Waterfall",
  period: "Period",
  periodValue: "01.01.2026 – 31.01.2026",
  currency: "Currency",
  currencyValue: "USD",
  rate: "Rate",
  rateValue: "At each operation's date",
  change: "Change",
  colColumn: "Column",
  colSection: "Section",
  colChange: "Change",
  colBalance: "Balance",
  section: (kind) => `section:${kind}`,
  columnName: (c) => c.key,
};

describe("buildWaterfallSheet", () => {
  const sheet = buildWaterfallSheet(COLUMNS, LABELS);

  it("states what the numbers were computed for", () => {
    expect(sheet[1].map((c) => c?.value)).toEqual(["Period", "01.01.2026 – 31.01.2026"]);
    expect(sheet[2][1]?.value).toBe("USD");
    expect(sheet[3][1]?.value).toBe("At each operation's date");
    expect(sheet[4][1]?.value).toBe(200);
  });

  it("gives one row per column, as real numbers", () => {
    const rows = sheet.slice(7);
    expect(rows.map((r) => r[0]?.value)).toEqual(["opening", "income", "other", "closing"]);
    expect(rows[1].map((c) => c?.value)).toEqual(["income", "section:income", 500.5, 1500.5]);
    expect(rows[2][2]?.value).toBe(-300.5);
    expect(rows[1][2]?.format).toBe("#,##0.00");
  });

  it("adds a group column only when some column stands under a bracket", () => {
    expect(sheet[6]).toHaveLength(4);
    const none = buildWaterfallSheet(COLUMNS, { ...LABELS, colGroup: "Group", groupName: () => undefined });
    expect(none[6]).toHaveLength(4);
    const grouped = buildWaterfallSheet(COLUMNS, {
      ...LABELS,
      colGroup: "Group",
      groupName: (c) => (c.key === "other" ? "Food" : undefined),
    });
    expect(grouped[6][4]?.value).toBe("Group");
    expect(grouped[9][4]?.value).toBe("Food");
    expect(grouped[7][4]?.value).toBe("");
  });

  it("leaves the change empty for the two balances", () => {
    const rows = sheet.slice(7);
    expect(rows[0][2]).toBeNull();
    expect(rows[3][2]).toBeNull();
    expect(rows[3][3]?.value).toBe(1200);
  });
});
