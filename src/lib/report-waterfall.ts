import { Category, CellTarget, ReportView, WaterfallFixedRate, WaterfallResponse } from "./api";
import { parseMoneyToMinor } from "./money";

export type WaterfallColumnKind =
  | "opening"
  | "income"
  | "incomeStep"
  | "otherIncome"
  | "expense"
  | "system"
  | "other"
  | "closing";

export interface WaterfallColumn {
  key: string;
  kind: WaterfallColumnKind;
  /** Set for the category columns the user added. */
  categoryId: number | null;
  /** Signed: what the column adds to the balance. For the two totals, the total. */
  deltaMinor: number;
  /** The balance before and after this column. */
  startMinor: number;
  endMinor: number;
}

/** A report view is a waterfall when its config says so; everything else is the Cash Flow pivot. */
export function isWaterfallView(view: Pick<ReportView, "config">): boolean {
  try {
    return (JSON.parse(view.config) as { kind?: string }).kind === "waterfall";
  } catch {
    return false;
  }
}

function minor(amount: string): number {
  return parseMoneyToMinor(amount) ?? 0;
}

export interface WaterfallAllocation {
  /** What each category holds now: its own money and that of its subcategories,
   *  except subtrees that are columns of their own. For a column, the column's
   *  amount; for any other category, what adding it would pull out. */
  amounts: Map<number, number>;
  /** Money under no column, uncategorised included. */
  otherIncome: number;
  otherExpense: number;
}

export function allocateToSteps(
  data: WaterfallResponse,
  categories: Category[],
  steps: number[],
): WaterfallAllocation {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const picked = new Set(steps);
  const amounts = new Map<number, number>();
  let otherIncome = minor(data.uncategorizedIncome);
  let otherExpense = minor(data.uncategorizedExpense);
  for (const { categoryId, amount } of data.categories) {
    const own = minor(amount);
    let node = byId.get(categoryId);
    let reachedStep = false;
    const seen = new Set<number>();
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      amounts.set(node.id, (amounts.get(node.id) ?? 0) + own);
      if (picked.has(node.id)) {
        reachedStep = true;
        break;
      }
      node = node.parentId === null ? undefined : byId.get(node.parentId);
    }
    if (reachedStep) continue;
    if (byId.get(categoryId)?.kind === "income") otherIncome += own;
    else otherExpense += own;
  }
  return { amounts, otherIncome, otherExpense };
}

function ancestorIds(id: number, categories: Category[]): number[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out: number[] = [];
  const seen = new Set([id]);
  let parent = byId.get(id)?.parentId ?? null;
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    out.push(parent);
    parent = byId.get(parent)?.parentId ?? null;
  }
  return out;
}

/** The saved brackets that can be drawn: expense groups that are columns. They
 *  don't nest, so if moving categories around made one sit inside another, the
 *  one saved first wins. */
export function activeBrackets(brackets: number[], steps: number[], categories: Category[]): number[] {
  const out: number[] = [];
  for (const id of brackets) {
    if (out.includes(id) || !steps.includes(id)) continue;
    if (categories.find((c) => c.id === id)?.kind !== "expense") continue;
    if (bracketConflict(id, out, categories) === null) out.push(id);
  }
  return out;
}

/** The bracket that stops this group from getting one of its own: the group sits
 *  inside it, or holds it. */
export function bracketConflict(id: number, brackets: number[], categories: Category[]): number | null {
  const above = ancestorIds(id, categories).find((a) => brackets.includes(a));
  if (above !== undefined) return above;
  return brackets.find((b) => ancestorIds(b, categories).includes(id)) ?? null;
}

/** The bracket a column stands under, when that isn't its own. */
export function bracketOf(id: number, brackets: number[], categories: Category[]): number | null {
  return ancestorIds(id, categories).find((a) => brackets.includes(a)) ?? null;
}

/** The steps whose categories still exist, in the user's order, except that
 *  income comes before expenses, a nested category always comes before the group
 *  it belongs to (the group's column is what is left without the nested), and
 *  the columns of a bracketed group stand side by side, in the group's place. */
export function orderedSteps(steps: number[], categories: Category[], brackets: number[] = []): number[] {
  const kinds = new Map(categories.map((c) => [c.id, c.kind]));
  const out: number[] = [];
  for (const id of steps) {
    if (!kinds.has(id) || out.includes(id)) continue;
    const ancestors = new Set(ancestorIds(id, categories));
    const firstAncestor = out.findIndex((s) => ancestors.has(s));
    if (firstAncestor >= 0) out.splice(firstAncestor, 0, id);
    else out.push(id);
  }
  const ordered = [...out.filter((id) => kinds.get(id) === "income"), ...out.filter((id) => kinds.get(id) !== "income")];
  return brackets.reduce((list, group) => {
    if (!list.includes(group)) return list;
    const inside = list.filter((id) => ancestorIds(id, categories).includes(group));
    const rest = list.filter((id) => !inside.includes(id));
    rest.splice(rest.indexOf(group), 0, ...inside);
    return rest;
  }, ordered);
}

/** The column that already holds this category's money, if any: its nearest
 *  ancestor among the steps. Such a category can't get a column of its own,
 *  unless that column is a bracketed group's: there it is the group's remainder,
 *  and the user picks which subcategories stand beside it. */
export function coveredByStep(
  id: number,
  steps: number[],
  categories: Category[],
  brackets: number[] = [],
): number | null {
  const nearest = ancestorIds(id, categories).find((a) => steps.includes(a));
  return nearest === undefined || brackets.includes(nearest) ? null : nearest;
}

/** Steps nested in this one: its column shows only what is left without them. */
export function carvedOutSteps(id: number, steps: number[], categories: Category[]): number[] {
  return steps.filter((s) => ancestorIds(s, categories).includes(id));
}

/**
 * Opening balance → the chosen income categories → the rest of the income (all
 * of it when none is chosen) → rates and adjustments, if any, which are neither
 * → the chosen expense categories → other expenses, always → closing balance.
 * The middle columns add up from the first to the last by construction.
 */
export function buildWaterfallColumns(
  data: WaterfallResponse,
  categories: Category[],
  steps: number[],
): WaterfallColumn[] {
  const known = orderedSteps(steps, categories);
  const { amounts, otherIncome, otherExpense } = allocateToSteps(data, categories, known);
  const kinds = new Map(categories.map((c) => [c.id, c.kind]));
  const incomeSteps = known.filter((id) => kinds.get(id) === "income");
  const expenseSteps = known.filter((id) => kinds.get(id) !== "income");
  const system = minor(data.adjustments) + minor(data.fxDifference);

  const middle: Pick<WaterfallColumn, "key" | "kind" | "categoryId" | "deltaMinor">[] = [
    ...incomeSteps.map((id) => ({
      key: `step:${id}`,
      kind: "incomeStep" as const,
      categoryId: id,
      deltaMinor: amounts.get(id) ?? 0,
    })),
    ...(incomeSteps.length === 0
      ? [{ key: "income", kind: "income" as const, categoryId: null, deltaMinor: otherIncome }]
      : otherIncome !== 0
        ? [{ key: "otherIncome", kind: "otherIncome" as const, categoryId: null, deltaMinor: otherIncome }]
        : []),
    ...(system !== 0
      ? [{ key: "system", kind: "system" as const, categoryId: null, deltaMinor: system }]
      : []),
    ...expenseSteps.map((id) => ({
      key: `step:${id}`,
      kind: "expense" as const,
      categoryId: id,
      deltaMinor: -(amounts.get(id) ?? 0),
    })),
    { key: "other", kind: "other", categoryId: null, deltaMinor: -otherExpense },
  ];

  const opening = minor(data.opening);
  const closing = minor(data.closing);
  const columns: WaterfallColumn[] = [
    { key: "opening", kind: "opening", categoryId: null, deltaMinor: opening, startMinor: 0, endMinor: opening },
  ];
  let balance = opening;
  for (const c of middle) {
    columns.push({ ...c, startMinor: balance, endMinor: balance + c.deltaMinor });
    balance += c.deltaMinor;
  }
  columns.push({ key: "closing", kind: "closing", categoryId: null, deltaMinor: closing, startMinor: 0, endMinor: closing });
  return columns;
}

/** The chart without the columns that hold no money. Removing them moves no
 *  balance, so the rest still adds up. The two totals stay whatever they hold:
 *  they are what the chart goes from and to. */
export function withoutZeroColumns(columns: WaterfallColumn[]): WaterfallColumn[] {
  return columns.filter((c) => c.kind === "opening" || c.kind === "closing" || c.deltaMinor !== 0);
}

/** A rate as typed, ready to send, or null while it isn't a positive number yet. */
export function normalizeRate(typed: string): string | null {
  const value = typed.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(value) && Number(value) > 0 ? value : null;
}

/** The rates to send: the ones typed so far that make sense, for the currencies
 *  still in the report. Anything else falls back to the suggestion. */
export function validFixedRates(
  rates: Record<string, WaterfallFixedRate> | undefined,
  currencies: string[],
): WaterfallFixedRate[] {
  const out: WaterfallFixedRate[] = [];
  for (const currency of currencies) {
    const entry = rates?.[currency];
    const rate = entry ? normalizeRate(entry.rate) : null;
    if (entry && rate) out.push({ ...entry, rate });
  }
  return out;
}

export interface WaterfallZone {
  kind: "income" | "expense";
  /** Position among the columns; a zone's columns always stand side by side. */
  start: number;
  count: number;
  /** Signed, like the columns. */
  totalMinor: number;
}

/** The income part and the expense part of the chart. */
export function waterfallZones(columns: WaterfallColumn[]): WaterfallZone[] {
  const zones: WaterfallZone[] = [];
  columns.forEach((column, index) => {
    const kind =
      column.kind === "income" || column.kind === "incomeStep" || column.kind === "otherIncome"
        ? "income"
        : column.kind === "expense" || column.kind === "other"
          ? "expense"
          : null;
    if (!kind) return;
    const last = zones[zones.length - 1];
    if (last?.kind === kind) {
      last.count += 1;
      last.totalMinor += column.deltaMinor;
    } else {
      zones.push({ kind, start: index, count: 1, totalMinor: column.deltaMinor });
    }
  });
  return zones;
}

export interface WaterfallBracket {
  categoryId: number;
  /** Position among the columns; a bracket's columns always stand side by side. */
  start: number;
  count: number;
  /** Signed, like the columns: the whole group, what stands beside its column included. */
  totalMinor: number;
}

/** The brackets to draw over these columns. A group with no column left (all of
 *  them hidden as zero) has none. */
export function waterfallBrackets(
  columns: WaterfallColumn[],
  brackets: number[],
  categories: Category[],
): WaterfallBracket[] {
  const out: WaterfallBracket[] = [];
  for (const categoryId of brackets) {
    const group = subtreeIds(categoryId, categories);
    const held = columns.flatMap((c, i) => (c.categoryId !== null && group.has(c.categoryId) ? [i] : []));
    if (held.length === 0) continue;
    out.push({
      categoryId,
      start: held[0],
      count: held.length,
      totalMinor: held.reduce((sum, i) => sum + columns[i].deltaMinor, 0),
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** A curly brace as one SVG path, so it stays a single smooth line at any length:
 *  the legs start at 0 and `length`, the tip reaches `depth` halfway between them.
 *  It runs down the page with the tip to the right ("down"), or along the page
 *  with the tip above ("across"). The curves shrink on short braces. */
export function bracePath(length: number, depth: number, direction: "down" | "across"): string {
  const stem = depth / 2;
  const curve = Math.min(length / 4, depth * 0.6);
  const mid = length / 2;
  const at = (along: number, out: number) => (direction === "down" ? `${out} ${along}` : `${along} ${depth - out}`);
  return [
    `M${at(0, 0)}`,
    `Q${at(0, stem)} ${at(curve, stem)}`,
    `L${at(mid - curve, stem)}`,
    `Q${at(mid, stem)} ${at(mid, depth)}`,
    `Q${at(mid, stem)} ${at(mid + curve, stem)}`,
    `L${at(length - curve, stem)}`,
    `Q${at(length, stem)} ${at(length, 0)}`,
  ].join(" ");
}

export interface WaterfallScale {
  min: number;
  max: number;
  ticks: number[];
}

/** Round axis bounds and ticks around the columns; zero is always on the axis. */
export function waterfallScale(columns: WaterfallColumn[], tickCount = 5): WaterfallScale {
  const values = columns.flatMap((c) => [c.startMinor, c.endMinor]);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  if (lo === hi) return { min: 0, max: 100, ticks: [0, 100] };
  const rough = (hi - lo) / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find((m) => m * magnitude >= rough) ?? 10) * magnitude;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v));
  return { min, max, ticks };
}

/** Step list changes, pure so the screen and the tests agree. A new step goes
 *  last, so a group added after its nested categories lands after them. */
export function addStep(steps: number[], id: number, categories: Category[], brackets: number[] = []): number[] {
  if (steps.includes(id) || coveredByStep(id, steps, categories, brackets) !== null) return steps;
  return [...steps, id];
}

export function toggleStep(steps: number[], id: number, categories: Category[], brackets: number[] = []): number[] {
  return steps.includes(id) ? steps.filter((s) => s !== id) : addStep(steps, id, categories, brackets);
}

/** What moves together with a step: a bracketed group takes its columns along. */
function stepBlock(id: number, steps: number[], categories: Category[], brackets: number[]): number[] {
  if (!brackets.includes(id)) return [id];
  return steps.filter((s) => s === id || ancestorIds(s, categories).includes(id));
}

/** The two neighbouring runs of steps that an arrow would swap, or null when it
 *  can't: past the other section, past the edge of the step's own bracket, or
 *  so that a group lands before something nested in it. Expects `orderedSteps`. */
function moveBlocks(
  steps: number[],
  id: number,
  dir: -1 | 1,
  categories: Category[],
  brackets: number[],
): { moved: number[]; passed: number[] } | null {
  if (!steps.includes(id)) return null;
  const moved = stepBlock(id, steps, categories, brackets);
  const start = steps.indexOf(moved[0]);
  const neighbour = steps[dir === 1 ? start + moved.length : start - 1];
  if (neighbour === undefined) return null;
  const kindOf = (step: number) => categories.find((c) => c.id === step)?.kind;
  if (kindOf(id) !== kindOf(neighbour)) return null;
  const own = bracketOf(id, brackets, categories);
  const theirs = bracketOf(neighbour, brackets, categories);
  if (own !== null && theirs !== own) return null;
  const passed = own !== null ? [neighbour] : stepBlock(theirs ?? neighbour, steps, categories, brackets);
  const [nested, groups] = dir === 1 ? [moved, passed] : [passed, moved];
  const blocked = nested.some((n) => ancestorIds(n, categories).some((a) => groups.includes(a)));
  return blocked ? null : { moved, passed };
}

/** A step can swap with its neighbour unless that would put a group before
 *  something nested in it. Under a bracket it stays among the group's columns;
 *  a bracketed group moves with all of them, and others pass it whole. */
export function canMoveStep(
  steps: number[],
  id: number,
  dir: -1 | 1,
  categories: Category[],
  brackets: number[] = [],
): boolean {
  return moveBlocks(steps, id, dir, categories, brackets) !== null;
}

export function moveStep(
  steps: number[],
  id: number,
  dir: -1 | 1,
  categories: Category[],
  brackets: number[] = [],
): number[] {
  const blocks = moveBlocks(steps, id, dir, categories, brackets);
  if (!blocks) return steps;
  const { moved, passed } = blocks;
  const start = steps.indexOf((dir === 1 ? moved : passed)[0]);
  const swapped = dir === 1 ? [...passed, ...moved] : [...moved, ...passed];
  return [...steps.slice(0, start), ...swapped, ...steps.slice(start + swapped.length)];
}

function subtreeIds(id: number, categories: Category[]): Set<number> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of categories) {
      if (c.parentId !== null && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

/** The selection and target that make `report_cell_transactions` list exactly
 *  the transactions behind one figure of the chart. */
export interface WaterfallDrill {
  expenseCategoryIds: number[];
  incomeCategoryIds: number[];
  target: CellTarget;
}

const drillTarget = (
  section: "income" | "expense",
  categoryId: number | null,
  includeSubtree: boolean,
): CellTarget => ({ section, categoryId, includeSubtree, periodKey: null });

/** A category with its subcategories, minus the ones that are columns of their own. */
export function drillCategory(id: number, categories: Category[], steps: number[]): WaterfallDrill {
  const selected = subtreeIds(id, categories);
  for (const step of steps) {
    if (step !== id && selected.has(step)) {
      for (const inner of subtreeIds(step, categories)) selected.delete(inner);
    }
  }
  const kind = categories.find((c) => c.id === id)?.kind;
  const ids = [...selected];
  return kind === "income"
    ? { expenseCategoryIds: [], incomeCategoryIds: ids, target: drillTarget("income", id, true) }
    : { expenseCategoryIds: ids, incomeCategoryIds: [], target: drillTarget("expense", id, true) };
}

/** A category's direct money only, none of its subcategories. */
export function drillOwn(id: number, categories: Category[]): WaterfallDrill {
  const kind = categories.find((c) => c.id === id)?.kind;
  return kind === "income"
    ? { expenseCategoryIds: [], incomeCategoryIds: [id], target: drillTarget("income", id, false) }
    : { expenseCategoryIds: [id], incomeCategoryIds: [], target: drillTarget("expense", id, false) };
}

/** Everything in the section that is outside `selected`: the backend's
 *  uncategorised row holds residuals and unselected categories alike. */
function drillOutside(section: "income" | "expense", selected: number[]): WaterfallDrill {
  return section === "income"
    ? { expenseCategoryIds: [], incomeCategoryIds: selected, target: drillTarget("income", null, false) }
    : { expenseCategoryIds: selected, incomeCategoryIds: [], target: drillTarget("expense", null, false) };
}

/** The "other" column of a section: everything outside its columns' subtrees. */
export function drillRest(
  section: "income" | "expense",
  categories: Category[],
  steps: number[],
): WaterfallDrill {
  const selected = new Set<number>();
  for (const step of steps) {
    if (categories.find((c) => c.id === step)?.kind !== section) continue;
    for (const id of subtreeIds(step, categories)) selected.add(id);
  }
  return drillOutside(section, [...selected]);
}

/** Only the money with no category at all. */
export function drillUncategorized(section: "income" | "expense", categories: Category[]): WaterfallDrill {
  return drillOutside(section, categories.filter((c) => c.kind === section).map((c) => c.id));
}
