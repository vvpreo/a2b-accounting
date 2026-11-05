import { describe, expect, it } from "vitest";

import { Category, WaterfallResponse } from "./api";
import {
  activeBrackets,
  addStep,
  allocateToSteps,
  bracePath,
  bracketConflict,
  bracketOf,
  buildWaterfallColumns,
  canMoveStep,
  carvedOutSteps,
  coveredByStep,
  drillCategory,
  drillOwn,
  drillRest,
  drillUncategorized,
  orderedSteps,
  isWaterfallView,
  moveStep,
  normalizeRate,
  validFixedRates,
  toggleStep,
  waterfallBrackets,
  waterfallScale,
  waterfallZones,
  withoutZeroColumns,
} from "./report-waterfall";

const cat = (id: number, kind: "income" | "expense", parentId: number | null = null): Category => ({
  id,
  name: `c${id}`,
  color: "#888888",
  kind,
  parentId,
  description: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

// Income: 1. Expenses: 2 → 3 → 4 (a chain), 5 on its own.
const CATEGORIES = [cat(1, "income"), cat(2, "expense"), cat(3, "expense", 2), cat(4, "expense", 3), cat(5, "expense")];

const DATA: WaterfallResponse = {
  currency: "USD",
  opening: "1000.00",
  closing: "1125.00",
  categories: [
    { categoryId: 1, amount: "500.00" },
    { categoryId: 2, amount: "10.00" },
    { categoryId: 3, amount: "20.00" },
    { categoryId: 4, amount: "40.00" },
    { categoryId: 5, amount: "80.00" },
  ],
  uncategorizedIncome: "1.00",
  uncategorizedExpense: "16.00",
  adjustments: "-200.00",
  fxDifference: "-10.00",
  accounts: [],
  missingRates: [],
  staleRates: [],
  suggestedRates: [],
};

const shape = (steps: number[], data = DATA) =>
  buildWaterfallColumns(data, CATEGORIES, steps).map((c) => [c.key, c.deltaMinor]);

describe("allocateToSteps", () => {
  it("rolls subcategories up and leaves every expense in Other with no columns", () => {
    const a = allocateToSteps(DATA, CATEGORIES, []);
    expect(a.amounts.get(2)).toBe(7000);
    expect(a.amounts.get(3)).toBe(6000);
    expect(a.otherIncome).toBe(50100);
    expect(a.otherExpense).toBe(16600);
  });

  it("takes a subcategory that is its own column out of its parent", () => {
    const a = allocateToSteps(DATA, CATEGORIES, [2, 4]);
    expect(a.amounts.get(4)).toBe(4000);
    expect(a.amounts.get(2)).toBe(3000);
    expect(a.otherExpense).toBe(9600);
  });
});

describe("buildWaterfallColumns", () => {
  it("with no categories goes opening, income, system, other, closing", () => {
    expect(shape([])).toEqual([
      ["opening", 100000],
      ["income", 50100],
      ["system", -21000],
      ["other", -16600],
      ["closing", 112500],
    ]);
  });

  it("puts income second and the categories after it in the user's order", () => {
    expect(shape([5, 2]).map(([key]) => key)).toEqual([
      "opening",
      "income",
      "system",
      "step:5",
      "step:2",
      "other",
      "closing",
    ]);
  });

  it("splits the chart into an income and an expense part, with the system column in neither", () => {
    expect(waterfallZones(buildWaterfallColumns(DATA, CATEGORIES, [1, 5, 2]))).toEqual([
      { kind: "income", start: 1, count: 2, totalMinor: 50100 },
      { kind: "expense", start: 4, count: 3, totalMinor: -16600 },
    ]);
  });

  it("always has Other right before the closing balance, even when empty", () => {
    const data = { ...DATA, categories: [], uncategorizedExpense: "0.00", adjustments: "0.00", fxDifference: "0.00" };
    expect(shape([], data).slice(-2)).toEqual([
      ["other", -0],
      ["closing", 112500],
    ]);
  });

  it("drops the system column when there is nothing in it", () => {
    const data = { ...DATA, adjustments: "5.00", fxDifference: "-5.00" };
    expect(shape([], data).map(([key]) => key)).not.toContain("system");
  });

  it("chains every column and lands on the closing balance", () => {
    const columns = buildWaterfallColumns(DATA, CATEGORIES, [5, 2]);
    for (let i = 1; i < columns.length - 1; i++) {
      expect(columns[i].startMinor).toBe(columns[i - 1].endMinor);
    }
    expect(columns[columns.length - 2].endMinor).toBe(columns[columns.length - 1].endMinor);
  });

  it("keeps a column without money this period", () => {
    const data = { ...DATA, categories: [] };
    expect(shape([5], data)).toContainEqual(["step:5", -0]);
  });

  it("shows a group added after its nested category without that category's money", () => {
    expect(shape([4, 2])).toEqual([
      ["opening", 100000],
      ["income", 50100],
      ["system", -21000],
      ["step:4", -4000],
      ["step:2", -3000],
      ["other", -9600],
      ["closing", 112500],
    ]);
  });

  it("ignores steps that are gone", () => {
    expect(orderedSteps([99, 5], CATEGORIES)).toEqual([5]);
    expect(shape([99]).map(([key]) => key)).toEqual(["opening", "income", "system", "other", "closing"]);
  });

  it("splits income into its own columns before the expenses", () => {
    expect(shape([5, 1])).toEqual([
      ["opening", 100000],
      ["step:1", 50000],
      ["otherIncome", 100],
      ["system", -21000],
      ["step:5", -8000],
      ["other", -8600],
      ["closing", 112500],
    ]);
  });

  it("drops other income once the columns cover all of it", () => {
    const data = { ...DATA, uncategorizedIncome: "0.00" };
    expect(shape([1], data).map(([key]) => key)).not.toContain("otherIncome");
    expect(shape([1], data).map(([key]) => key)).not.toContain("income");
  });
});

describe("withoutZeroColumns", () => {
  const EMPTY: WaterfallResponse = {
    ...DATA,
    opening: "0.00",
    closing: "0.00",
    categories: [],
    uncategorizedIncome: "0.00",
    uncategorizedExpense: "0.00",
    adjustments: "0.00",
    fxDifference: "0.00",
  };

  it("drops the columns with no money, whichever kind they are", () => {
    const data: WaterfallResponse = {
      ...EMPTY,
      opening: "100.00",
      closing: "70.00",
      categories: [{ categoryId: 5, amount: "30.00" }],
    };
    // Income, the empty step 2 and "other" are all zero here.
    const kept = withoutZeroColumns(buildWaterfallColumns(data, CATEGORIES, [2, 5]));
    expect(kept.map((c) => c.key)).toEqual(["opening", "step:5", "closing"]);
  });

  it("keeps a column that holds even one cent, and a negative one", () => {
    const data: WaterfallResponse = {
      ...EMPTY,
      closing: "-0.99",
      uncategorizedIncome: "0.01",
      uncategorizedExpense: "1.00",
    };
    const kept = withoutZeroColumns(buildWaterfallColumns(data, CATEGORIES, []));
    expect(kept.map((c) => [c.key, c.deltaMinor])).toEqual([
      ["opening", 0],
      ["income", 1],
      ["other", -100],
      ["closing", -99],
    ]);
  });

  it("keeps both totals even when they are zero", () => {
    const kept = withoutZeroColumns(buildWaterfallColumns(EMPTY, CATEGORIES, [1, 2]));
    expect(kept.map((c) => c.key)).toEqual(["opening", "closing"]);
    expect(waterfallZones(kept)).toEqual([]);
  });

  it("leaves the chain unbroken and the zones right after the removal", () => {
    const data: WaterfallResponse = {
      ...EMPTY,
      opening: "100.00",
      closing: "120.00",
      categories: [
        { categoryId: 1, amount: "50.00" },
        { categoryId: 5, amount: "30.00" },
      ],
    };
    const kept = withoutZeroColumns(buildWaterfallColumns(data, CATEGORIES, [1, 2, 5]));
    expect(kept.map((c) => c.key)).toEqual(["opening", "step:1", "step:5", "closing"]);
    const middle = kept.slice(1, -1);
    middle.forEach((c, i) => expect(c.startMinor).toBe(kept[i].endMinor));
    expect(middle[middle.length - 1].endMinor).toBe(kept[kept.length - 1].endMinor);
    expect(waterfallZones(kept)).toEqual([
      { kind: "income", start: 1, count: 1, totalMinor: 5000 },
      { kind: "expense", start: 2, count: 1, totalMinor: -3000 },
    ]);
  });
});

describe("brackets", () => {
  // Expenses: group 10 holds 11 and 12; group 20 holds 21; 30 stands alone.
  const TREE = [
    cat(10, "expense"),
    cat(11, "expense", 10),
    cat(12, "expense", 10),
    cat(20, "expense"),
    cat(21, "expense", 20),
    cat(30, "expense"),
    cat(40, "income"),
    cat(41, "income", 40),
  ];
  const MONEY: WaterfallResponse = {
    ...DATA,
    opening: "1000.00",
    closing: "0.00",
    categories: [
      { categoryId: 10, amount: "100.00" }, // the group's own money
      { categoryId: 11, amount: "600.00" },
      { categoryId: 12, amount: "300.00" },
    ],
    uncategorizedIncome: "0.00",
    uncategorizedExpense: "0.00",
    adjustments: "0.00",
    fxDifference: "0.00",
  };
  const columnsOf = (steps: number[], brackets: number[]) =>
    buildWaterfallColumns(MONEY, TREE, orderedSteps(steps, TREE, brackets));

  it("lets a subcategory join a bracketed group that is already a column", () => {
    expect(coveredByStep(11, [10], TREE)).toBe(10);
    expect(coveredByStep(11, [10], TREE, [10])).toBeNull();
    expect(addStep([10], 11, TREE)).toEqual([10]);
    expect(orderedSteps(addStep([10], 11, TREE, [10]), TREE, [10])).toEqual([11, 10]);
  });

  it("totals the whole group: the picked columns and the remainder", () => {
    const columns = columnsOf([11, 10], [10]);
    expect(columns.filter((c) => c.categoryId !== null).map((c) => [c.categoryId, c.deltaMinor])).toEqual([
      [11, -60000],
      [10, -40000],
    ]);
    expect(waterfallBrackets(columns, [10], TREE)).toEqual([
      { categoryId: 10, start: 2, count: 2, totalMinor: -100000 },
    ]);
  });

  it("keeps the total when only the group's own column is shown", () => {
    const columns = columnsOf([10], [10]);
    expect(waterfallBrackets(columns, [10], TREE)[0]).toMatchObject({ count: 1, totalMinor: -100000 });
  });

  it("brings a group's columns together, in the group's place", () => {
    expect(orderedSteps([11, 30, 10], TREE)).toEqual([11, 30, 10]);
    expect(orderedSteps([11, 30, 10], TREE, [10])).toEqual([30, 11, 10]);
    expect(orderedSteps([12, 30, 11, 20, 10], TREE, [10])).toEqual([30, 20, 12, 11, 10]);
  });

  it("is stable: ordering twice changes nothing", () => {
    const once = orderedSteps([12, 30, 11, 20, 10], TREE, [10]);
    expect(orderedSteps(once, TREE, [10])).toEqual(once);
  });

  it("counts positions after zero columns are hidden, and drops an empty group", () => {
    const steps = orderedSteps([20, 11, 12, 10], TREE, [10, 20]);
    const all = buildWaterfallColumns({ ...MONEY, categories: [{ categoryId: 11, amount: "5.00" }] }, TREE, steps);
    const kept = withoutZeroColumns(all);
    expect(waterfallBrackets(kept, [10, 20], TREE)).toEqual([
      { categoryId: 10, start: 1, count: 1, totalMinor: -500 },
    ]);
  });

  it("reads only expense groups that are columns, without nesting", () => {
    const nested = [cat(1, "expense"), cat(2, "expense", 1), cat(3, "expense", 2)];
    expect(activeBrackets([10, 99, 40, 20], [10, 40], TREE)).toEqual([10]);
    expect(activeBrackets([2, 1], [1, 2], nested)).toEqual([2]);
    expect(bracketConflict(3, [1], nested)).toBe(1);
    expect(bracketConflict(1, [3], nested)).toBe(3);
    expect(bracketConflict(10, [20], TREE)).toBeNull();
    expect(bracketOf(11, [10], TREE)).toBe(10);
    expect(bracketOf(10, [10], TREE)).toBeNull();
  });

  describe("arrows", () => {
    const steps = [30, 11, 12, 10, 20];
    const b = [10];

    it("moves a column only among its group's columns", () => {
      expect(moveStep(steps, 12, -1, TREE, b)).toEqual([30, 12, 11, 10, 20]);
      expect(canMoveStep(steps, 11, -1, TREE, b)).toBe(false);
      // The remainder stays last under the bracket.
      expect(canMoveStep(steps, 12, 1, TREE, b)).toBe(false);
      expect(moveStep(steps, 11, -1, TREE, b)).toEqual(steps);
    });

    it("moves a bracketed group with all its columns", () => {
      expect(moveStep(steps, 10, -1, TREE, b)).toEqual([11, 12, 10, 30, 20]);
      expect(moveStep(steps, 10, 1, TREE, b)).toEqual([30, 20, 11, 12, 10]);
    });

    it("takes another column past a bracket whole", () => {
      expect(moveStep(steps, 30, 1, TREE, b)).toEqual([11, 12, 10, 30, 20]);
      expect(moveStep(steps, 20, -1, TREE, b)).toEqual([30, 20, 11, 12, 10]);
    });

    it("swaps two bracketed groups whole", () => {
      const two = [11, 10, 21, 20];
      expect(moveStep(two, 20, -1, TREE, [10, 20])).toEqual([21, 20, 11, 10]);
      expect(moveStep(two, 10, 1, TREE, [10, 20])).toEqual([21, 20, 11, 10]);
    });

    it("stops at the ends and at income", () => {
      expect(canMoveStep([11, 10], 10, 1, TREE, b)).toBe(false);
      expect(canMoveStep([11, 10], 10, -1, TREE, b)).toBe(false);
      expect(canMoveStep([40, 11, 10], 10, -1, TREE, b)).toBe(false);
    });

    it("behaves as before without brackets", () => {
      expect(moveStep([30, 20], 30, 1, TREE)).toEqual([20, 30]);
      expect(canMoveStep([11, 10], 11, 1, TREE)).toBe(false);
    });
  });
});

describe("bracePath", () => {
  const points = (d: string) => [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

  it("runs down the page from one leg to the other, the tip at the middle", () => {
    const d = bracePath(100, 14, "down");
    const p = points(d);
    expect(p[0]).toEqual([0, 0]);
    expect(p[p.length - 1]).toEqual([0, 100]);
    expect(p).toContainEqual([14, 50]);
    expect(d.match(/M/g)).toHaveLength(1);
  });

  it("is the same curve lying along the page, the tip above", () => {
    const flipped = points(bracePath(100, 14, "down")).map(([x, y]) => [y, 14 - x]);
    expect(points(bracePath(100, 14, "across"))).toEqual(flipped);
  });

  it("stays inside its size on a short brace: the curves don't overlap", () => {
    const p = points(bracePath(20, 14, "down"));
    expect(p.every(([x, y]) => x >= 0 && x <= 14 && y >= 0 && y <= 20)).toBe(true);
    const along = p.map(([, y]) => y);
    along.forEach((y, i) => i === 0 || expect(y).toBeGreaterThanOrEqual(along[i - 1] - 5));
    expect(bracePath(20, 14, "down")).toContain("L7 5 Q7 10 14 10");
  });
});

describe("waterfallScale", () => {
  const column = (startMinor: number, endMinor: number) => ({
    key: "x",
    kind: "expense" as const,
    categoryId: null,
    deltaMinor: endMinor - startMinor,
    startMinor,
    endMinor,
  });

  it("covers the values with round ticks and includes zero", () => {
    const s = waterfallScale([column(0, 123456), column(123456, 80000)]);
    expect(s.min).toBe(0);
    expect(s.max).toBeGreaterThanOrEqual(123456);
    expect(s.ticks[0]).toBe(0);
    expect(s.ticks).toContain(s.max);
  });

  it("extends below zero when the balance dips", () => {
    const s = waterfallScale([column(1000, -2500)]);
    expect(s.min).toBeLessThanOrEqual(-2500);
    expect(s.ticks).toContain(0);
  });

  it("survives an all-zero report", () => {
    expect(waterfallScale([column(0, 0)]).max).toBeGreaterThan(0);
  });
});

describe("step list", () => {
  it("toggles in click order", () => {
    expect(toggleStep([5], 3, CATEGORIES)).toEqual([5, 3]);
    expect(toggleStep([5, 3], 5, CATEGORIES)).toEqual([3]);
  });

  it("does not add what a group already covers, at any depth", () => {
    expect(addStep([2], 3, CATEGORIES)).toEqual([2]);
    expect(addStep([2], 4, CATEGORIES)).toEqual([2]);
    expect(coveredByStep(4, [2], CATEGORIES)).toBe(2);
    expect(coveredByStep(4, [3, 2], CATEGORIES)).toBe(3);
    expect(coveredByStep(5, [2], CATEGORIES)).toBeNull();
  });

  it("adds a group after what is nested in it", () => {
    expect(addStep([4, 5], 2, CATEGORIES)).toEqual([4, 5, 2]);
    expect(addStep([4], 3, CATEGORIES)).toEqual([4, 3]);
    expect(carvedOutSteps(2, [4, 3, 2], CATEGORIES)).toEqual([4, 3]);
    expect(carvedOutSteps(4, [4, 3, 2], CATEGORIES)).toEqual([]);
  });

  it("moves within bounds", () => {
    expect(moveStep([2, 5, 4], 5, -1, CATEGORIES)).toEqual([5, 2, 4]);
    expect(moveStep([5, 2], 2, 1, CATEGORIES)).toEqual([5, 2]);
    expect(moveStep([5, 2], 5, -1, CATEGORIES)).toEqual([5, 2]);
  });

  it("never lets a group pass something nested in it", () => {
    expect(canMoveStep([4, 2], 4, 1, CATEGORIES)).toBe(false);
    expect(canMoveStep([4, 2], 2, -1, CATEGORIES)).toBe(false);
    expect(moveStep([4, 2], 4, 1, CATEGORIES)).toEqual([4, 2]);
    expect(canMoveStep([4, 5, 2], 5, 1, CATEGORIES)).toBe(true);
  });

  it("repairs an older order that has a group before its nested category", () => {
    expect(orderedSteps([2, 5, 4], CATEGORIES)).toEqual([4, 2, 5]);
    expect(orderedSteps([2, 3, 4], CATEGORIES)).toEqual([4, 3, 2]);
    expect(orderedSteps([5, 5], CATEGORIES)).toEqual([5]);
  });

  it("keeps income before expenses, and a step within its own kind", () => {
    expect(orderedSteps([5, 1], CATEGORIES)).toEqual([1, 5]);
    expect(canMoveStep([1, 5], 5, -1, CATEGORIES)).toBe(false);
    expect(canMoveStep([1, 5], 1, 1, CATEGORIES)).toBe(false);
  });
});

describe("drill-downs", () => {
  it("a category leaves out subcategories that are columns of their own", () => {
    const d = drillCategory(2, CATEGORIES, [2, 4]);
    expect(d.expenseCategoryIds.sort()).toEqual([2, 3]);
    expect(d.target).toEqual({ section: "expense", categoryId: 2, includeSubtree: true, periodKey: null });
  });

  it("a column that is a subcategory is not cut by its parent's column", () => {
    expect(drillCategory(4, CATEGORIES, [2, 4]).expenseCategoryIds).toEqual([4]);
  });

  it("the rest selects the section's columns and targets what is outside them", () => {
    const d = drillRest("expense", CATEGORIES, [3, 1]);
    expect(d.expenseCategoryIds.sort()).toEqual([3, 4]);
    expect(d.target.categoryId).toBeNull();
    expect(d.target.section).toBe("expense");
    expect(drillRest("income", CATEGORIES, [3, 1]).incomeCategoryIds).toEqual([1]);
  });

  it("no category selects everything in the section", () => {
    expect(drillUncategorized("expense", CATEGORIES).expenseCategoryIds).toEqual([2, 3, 4, 5]);
    expect(drillUncategorized("income", CATEGORIES).incomeCategoryIds).toEqual([1]);
  });

  it("all income selects nothing, so nothing is left out", () => {
    const d = drillRest("income", CATEGORIES, []);
    expect(d.incomeCategoryIds).toEqual([]);
    expect(d.target.section).toBe("income");
  });

  it("own money excludes the subtree", () => {
    const d = drillOwn(2, CATEGORIES);
    expect(d.expenseCategoryIds).toEqual([2]);
    expect(d.target.includeSubtree).toBe(false);
  });
});

describe("fixed rates", () => {
  it("accepts positive numbers with either decimal separator", () => {
    expect(normalizeRate(" 37,8 ")).toBe("37.8");
    expect(normalizeRate("35")).toBe("35");
    for (const bad of ["", "0", "0.00", "-3", "3.", "abc", "1,2,3"]) {
      expect(normalizeRate(bad)).toBeNull();
    }
  });

  it("sends only what makes sense for the currencies in the report", () => {
    const rates = {
      THB: { currency: "THB", rate: "37,8", perReport: true },
      USD: { currency: "USD", rate: "", perReport: true },
      GBP: { currency: "GBP", rate: "1.2", perReport: false },
    };
    expect(validFixedRates(rates, ["THB", "USD"])).toEqual([{ currency: "THB", rate: "37.8", perReport: true }]);
    expect(validFixedRates(undefined, ["THB"])).toEqual([]);
  });
});

describe("isWaterfallView", () => {
  it("tells the kinds apart and survives a broken config", () => {
    expect(isWaterfallView({ config: '{"kind":"waterfall"}' })).toBe(true);
    expect(isWaterfallView({ config: '{"version":1}' })).toBe(false);
    expect(isWaterfallView({ config: "not json" })).toBe(false);
  });
});
