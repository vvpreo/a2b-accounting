import { describe, expect, it } from "vitest";

import { Transaction } from "./api";
import {
  defaultSourceMonth,
  firstDayOf,
  isRegular,
  planRegular,
  regularKey,
  scaleShares,
  shiftMonth,
  toggleRegular,
} from "./regular-payments";

let nextId = 1;
function txn(date: string, comment: string | null, debit = "100.00", credit = "0.00"): Transaction {
  return {
    id: nextId++,
    accountId: 1,
    importBatchId: null,
    // Midday, so the month does not depend on the time zone of the test run.
    occurredAtUtc: new Date(`${date}T12:00`).toISOString(),
    credit,
    debit,
    balance: "0.00",
    peer: null,
    bankDescription: null,
    comment,
    isCorrecting: false,
  } as Transaction;
}

describe("the regular mark", () => {
  it("counts only at the start of the comment", () => {
    expect(isRegular("🔄 Абонемент")).toBe(true);
    expect(isRegular("  🔄 Абонемент")).toBe(true);
    expect(isRegular("Абонемент 🔄")).toBe(false);
    expect(isRegular(null)).toBe(false);
  });

  it("ignores case, extra spaces and the emoji variation selector in the text", () => {
    expect(regularKey("🔄  Языковой   курс ")).toBe("языковой курс");
    expect(regularKey("🔄️ языковой курс")).toBe("языковой курс");
  });
});

describe("toggleRegular", () => {
  it("puts the mark with a space in front of the text", () => {
    expect(toggleRegular("Абонемент")).toBe("🔄 Абонемент");
    expect(toggleRegular("  Абонемент ")).toBe("🔄 Абонемент");
    expect(toggleRegular("")).toBe("🔄 ");
  });

  it("takes the mark and its space off", () => {
    expect(toggleRegular("🔄 Абонемент")).toBe("Абонемент");
    expect(toggleRegular("🔄Абонемент")).toBe("Абонемент");
    expect(toggleRegular("🔄\uFE0F Абонемент")).toBe("Абонемент");
    expect(toggleRegular("🔄 ")).toBe("");
  });

  it("leaves a mark further in the text alone", () => {
    expect(toggleRegular("Абонемент 🔄")).toBe("🔄 Абонемент 🔄");
  });
});

describe("months", () => {
  it("shifts across the year", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(firstDayOf("2026-11")).toBe("2026-11-01");
  });

  it("takes the nearest earlier month with regular entries as the source", () => {
    const txns = [txn("2026-08-05", "🔄 А"), txn("2026-10-05", "разовая"), txn("2026-12-01", "🔄 Б")];
    expect(defaultSourceMonth(txns, "2026-11")).toBe("2026-08");
    expect(defaultSourceMonth([], "2026-11")).toBe("2026-10");
  });
});

describe("planRegular", () => {
  it("adds what the target month lacks and keeps what it has, whatever the amount", () => {
    const here = txn("2026-11-03", "🔄 Абонемент", "2500.00");
    const course = txn("2026-10-02", "🔄 Языковой курс", "6000.00");
    const plan = planRegular(
      [
        txn("2026-10-01", "🔄 абонемент ", "2000.00"),
        course,
        txn("2026-10-09", "Кофе"),
        here,
        txn("2026-09-02", "🔄 Парковка"),
      ],
      "2026-11",
      "2026-10",
    );
    expect(plan.existing).toEqual([here]);
    expect(plan.toCreate).toEqual([{ source: course, sameTextInSource: 1 }]);
  });

  it("creates one payment per text and takes the source's first amount", () => {
    const first = txn("2026-10-01", "🔄 Вода", "300.00");
    const plan = planRegular([first, txn("2026-10-20", "🔄 вода", "400.00")], "2026-11", "2026-10");
    expect(plan.toCreate).toEqual([{ source: first, sameTextInSource: 2 }]);
  });

  it("has nothing to add once the target month is complete", () => {
    const txns = [txn("2026-10-01", "🔄 Вода"), txn("2026-11-01", "🔄 Вода")];
    expect(planRegular(txns, "2026-11", "2026-10").toCreate).toEqual([]);
  });
});

describe("scaleShares", () => {
  const a = { categoryId: 1, shareMinor: 7500 };
  const b = { categoryId: 2, shareMinor: 2500 };

  it("keeps the shares of an unchanged amount", () => {
    expect(scaleShares([a, b], 10000, 10000)).toEqual([a, b]);
  });

  it("stays fully categorized at a new amount", () => {
    expect(scaleShares([a, b], 10000, 10001)).toEqual([
      { categoryId: 1, shareMinor: 7500 },
      { categoryId: 2, shareMinor: 2501 },
    ]);
  });

  it("keeps a partly categorized entry partial", () => {
    expect(scaleShares([b], 10000, 20000)).toEqual([{ categoryId: 2, shareMinor: 5000 }]);
  });

  it("drops a share rounded down to nothing", () => {
    expect(scaleShares([{ categoryId: 1, shareMinor: 1 }], 10000, 100)).toEqual([]);
  });
});
