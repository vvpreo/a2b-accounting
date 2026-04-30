import React, { useEffect, useMemo, useState } from "react";

import { useT } from "../i18n";
import {
  computeReport,
  Granularity,
  RangePreset,
  ReportRange,
  ReportResponse,
  ReportRow,
  ReportView,
  SectionData,
} from "../lib/api";
import { formatMinorAsMoney, formatMoney, parseMoneyToMinor } from "../lib/money";

interface Props {
  view: ReportView;
  onEdit: () => void;
}

interface ReportConfigShape {
  version: 1;
  accountIds: number[];
  expenseCategoryIds: number[];
  incomeCategoryIds: number[];
  expenseShowUncategorized: boolean;
  incomeShowUncategorized: boolean;
  defaultRange: ReportRange;
  defaultGranularity: Granularity;
  expandedCategoryIds: number[];
}

const DEFAULT_CONFIG: ReportConfigShape = {
  version: 1,
  accountIds: [],
  expenseCategoryIds: [],
  incomeCategoryIds: [],
  expenseShowUncategorized: false,
  incomeShowUncategorized: false,
  defaultRange: { kind: "preset", preset: "current_year" },
  defaultGranularity: "month",
  expandedCategoryIds: [],
};

const PRESETS: RangePreset[] = [
  "current_month",
  "current_quarter",
  "current_year",
  "last_12_months",
  "all_time",
  "custom",
];

const GRANULARITIES: Granularity[] = ["year", "quarter", "month"];

// Font sizes per row depth in the pivot. Section header is styled separately
// (see .pivot-row--section in App.css).
const ROW_FONT_SIZES = [15, 13, 12, 11];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function lastDayOfMonth(year: number, monthOneIndexed: number): number {
  return new Date(year, monthOneIndexed, 0).getDate();
}

function todayIso(): string {
  const d = new Date();
  return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function firstOfMonthIso(): string {
  const d = new Date();
  return isoDate(d.getFullYear(), d.getMonth() + 1, 1);
}

function resolveRange(range: ReportRange): { from: string; to: string } {
  if (range.kind === "custom") return { from: range.from, to: range.to };
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  switch (range.preset) {
    case "current_month":
      return { from: isoDate(y, m, 1), to: isoDate(y, m, lastDayOfMonth(y, m)) };
    case "current_quarter": {
      const qStart = Math.floor((m - 1) / 3) * 3 + 1;
      const qEnd = qStart + 2;
      return {
        from: isoDate(y, qStart, 1),
        to: isoDate(y, qEnd, lastDayOfMonth(y, qEnd)),
      };
    }
    case "current_year":
      return { from: isoDate(y, 1, 1), to: isoDate(y, 12, 31) };
    case "last_12_months": {
      const start = new Date(y, m - 12, 1);
      return {
        from: isoDate(start.getFullYear(), start.getMonth() + 1, 1),
        to: isoDate(y, m, lastDayOfMonth(y, m)),
      };
    }
    case "all_time":
      return { from: "1970-01-01", to: isoDate(y, 12, 31) };
  }
}

function safeParseConfig(raw: string): ReportConfigShape {
  try {
    const parsed = JSON.parse(raw) as Partial<ReportConfigShape> & {
      showUncategorized?: boolean;
    };
    // Backwards compat with the legacy single `showUncategorized` flag.
    const legacyFallback = parsed.showUncategorized;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      expenseShowUncategorized:
        parsed.expenseShowUncategorized ??
        legacyFallback ??
        DEFAULT_CONFIG.expenseShowUncategorized,
      incomeShowUncategorized:
        parsed.incomeShowUncategorized ??
        legacyFallback ??
        DEFAULT_CONFIG.incomeShowUncategorized,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function ReportViewPage({ view, onEdit }: Props) {
  const t = useT();
  const config = useMemo(() => safeParseConfig(view.config), [view.config]);

  const [range, setRange] = useState<ReportRange>(config.defaultRange);
  const [granularity, setGranularity] = useState<Granularity>(config.defaultGranularity);

  // Reset runtime controls when switching between saved views.
  useEffect(() => {
    setRange(config.defaultRange);
    setGranularity(config.defaultGranularity);
  }, [view.id, config.defaultRange, config.defaultGranularity]);

  const [response, setResponse] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { from, to } = resolveRange(range);
    if (!from || !to || to < from) return;
    setLoading(true);
    setError(null);
    computeReport({
      accountIds: config.accountIds,
      expenseCategoryIds: config.expenseCategoryIds,
      incomeCategoryIds: config.incomeCategoryIds,
      expenseShowUncategorized: config.expenseShowUncategorized,
      incomeShowUncategorized: config.incomeShowUncategorized,
      from,
      to,
      granularity,
    })
      .then((r) => {
        if (!cancelled) setResponse(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    view.id,
    range,
    granularity,
    config.accountIds,
    config.expenseCategoryIds,
    config.incomeCategoryIds,
    config.expenseShowUncategorized,
    config.incomeShowUncategorized,
  ]);

  function setRangeKind(next: RangePreset) {
    if (next === "custom") {
      const from = range.kind === "custom" ? range.from : firstOfMonthIso();
      const to = range.kind === "custom" ? range.to : todayIso();
      setRange({ kind: "custom", from, to });
    } else {
      setRange({ kind: "preset", preset: next });
    }
  }

  return (
    <section className="page report-page">
      <div className="report-controls">
        <label>
          <span>{t("report.rangeLabel")}</span>
          <select
            value={range.kind === "preset" ? range.preset : "custom"}
            onChange={(e) => setRangeKind(e.target.value as RangePreset)}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {t(`builder.preset.${p}`)}
              </option>
            ))}
          </select>
        </label>
        {range.kind === "custom" && (
          <>
            <label>
              <span>{t("report.fromDate")}</span>
              <input
                type="date"
                value={range.from}
                onChange={(e) => setRange({ ...range, from: e.target.value })}
              />
            </label>
            <label>
              <span>{t("report.toDate")}</span>
              <input
                type="date"
                value={range.to}
                onChange={(e) => setRange({ ...range, to: e.target.value })}
              />
            </label>
          </>
        )}
        <label>
          <span>{t("report.granularityLabel")}</span>
          <select
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as Granularity)}
          >
            {GRANULARITIES.map((g) => (
              <option key={g} value={g}>
                {t(`builder.granularity.${g}`)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="icon-btn report-edit-btn"
          onClick={onEdit}
          title={t("report.edit")}
          aria-label={t("report.edit")}
        >
          ✎
        </button>
      </div>

      {error && (
        <div className="error">{t("report.errorLoading", { message: error })}</div>
      )}
      {loading && !response && <div className="report-loading">{t("report.loading")}</div>}

      {response && (
        <PivotTable
          response={response}
          initialExpanded={config.expandedCategoryIds}
          showUncategorized={
            config.expenseShowUncategorized || config.incomeShowUncategorized
          }
        />
      )}
    </section>
  );
}

interface PivotProps {
  response: ReportResponse;
  initialExpanded: number[];
  showUncategorized: boolean;
}

function PivotTable({ response, initialExpanded, showUncategorized }: PivotProps) {
  const t = useT();
  const { periods, expense, income } = response;
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [incomeCollapsed, setIncomeCollapsed] = useState(false);
  const [expenseCollapsed, setExpenseCollapsed] = useState(false);

  // Switching to a different view resets all collapse state.
  useEffect(() => {
    setCollapsed(new Set());
    setIncomeCollapsed(false);
    setExpenseCollapsed(false);
  }, [response, initialExpanded]);

  function toggleRow(catId: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }

  const incomeRows = renderSection({
    section: income,
    sectionKey: "income",
    sectionCollapsed: incomeCollapsed,
    onToggleSection: () => setIncomeCollapsed((v) => !v),
    rowCollapsed: collapsed,
    onToggleRow: toggleRow,
    sectionTitle: t("report.sectionIncome"),
    uncategorizedLabel: t("report.uncategorized"),
    foldLabel: t("report.fold"),
    unfoldLabel: t("report.unfold"),
  });
  const expenseRows = renderSection({
    section: expense,
    sectionKey: "expense",
    sectionCollapsed: expenseCollapsed,
    onToggleSection: () => setExpenseCollapsed((v) => !v),
    rowCollapsed: collapsed,
    onToggleRow: toggleRow,
    sectionTitle: t("report.sectionExpense"),
    uncategorizedLabel: t("report.uncategorized"),
    foldLabel: t("report.fold"),
    unfoldLabel: t("report.unfold"),
  });

  const isEmpty =
    expense.rows.length === 0 &&
    income.rows.length === 0 &&
    !showUncategorized;

  if (isEmpty) {
    return <div className="report-empty">{t("report.empty")}</div>;
  }

  return (
    <div className="pivot-wrap">
      <table className="pivot-table">
        <thead>
          <tr>
            <th className="pivot-name-col" />
            {periods.map((p) => (
              <th key={p.key} className="pivot-period-col">
                {p.label}
              </th>
            ))}
            <th className="pivot-total-col">{t("report.totalColumn")}</th>
          </tr>
        </thead>
        <tbody>
          {income.rows.length > 0 && incomeRows}
          {expense.rows.length > 0 && expenseRows}
        </tbody>
      </table>
    </div>
  );
}

interface RenderSectionArgs {
  section: SectionData;
  sectionKey: string;
  sectionCollapsed: boolean;
  onToggleSection: () => void;
  rowCollapsed: Set<number>;
  onToggleRow: (catId: number) => void;
  sectionTitle: string;
  uncategorizedLabel: string;
  foldLabel: string;
  unfoldLabel: string;
}

function renderSection({
  section,
  sectionKey,
  sectionCollapsed,
  onToggleSection,
  rowCollapsed,
  onToggleRow,
  sectionTitle,
  uncategorizedLabel,
  foldLabel,
  unfoldLabel,
}: RenderSectionArgs): React.ReactElement[] {
  const { rows } = section;
  const { parents, hasDescendants, subtreeValues, subtreeMinor, subtreeTotal, subtreeTotalMinor } =
    analyzeRows(rows);

  // Section totals are the sum of *root rows only* — child rows are already
  // rolled up into their parents (parent value == own + sum(descendants)),
  // so adding them again would double-count.
  const nPeriods = rows[0]?.values.length ?? 0;
  const sectionPerPeriodMinor = new Array<number>(nPeriods).fill(0);
  let sectionTotalMinor = 0;
  for (let i = 0; i < rows.length; i++) {
    if (parents[i] !== -1) continue;
    for (let k = 0; k < nPeriods; k++) {
      sectionPerPeriodMinor[k] += subtreeMinor[i][k];
    }
    sectionTotalMinor += subtreeTotalMinor[i];
  }
  const sectionPerPeriod = sectionPerPeriodMinor.map((m) => formatMinorAsMoney(m));
  const sectionTotalStr = formatMinorAsMoney(sectionTotalMinor);

  const out: React.ReactElement[] = [];
  // Section header row: title on the left + section totals across all periods.
  // Click anywhere on the title cell to collapse/expand the whole section.
  out.push(
    <tr
      key={`header-${sectionKey}`}
      className="pivot-row pivot-row--section"
    >
      <td
        className="pivot-name-cell pivot-name-cell--section"
        onClick={onToggleSection}
        title={sectionCollapsed ? unfoldLabel : foldLabel}
      >
        <span className="pivot-fold-btn pivot-fold-btn--section" aria-hidden>
          {sectionCollapsed ? "▸" : "▾"}
        </span>
        <span className="pivot-name-text">{sectionTitle}</span>
      </td>
      {sectionPerPeriod.map((v, idx) => (
        <td key={idx} className="pivot-value-cell">
          {formatMoney(v)}
        </td>
      ))}
      <td className="pivot-value-cell pivot-value-cell--total">
        {formatMoney(sectionTotalStr)}
      </td>
    </tr>,
  );

  if (sectionCollapsed) {
    return out;
  }

  // Walk rows in order; skip rows whose nearest ancestor (by row.depth chain) is collapsed.
  const collapsedAtDepth: Map<number, number> = new Map(); // depth -> first collapsed ancestor index
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Drop ancestors deeper than current depth from the collapse stack.
    for (const d of Array.from(collapsedAtDepth.keys())) {
      if (d >= row.depth) collapsedAtDepth.delete(d);
    }
    const ancestorCollapsed = collapsedAtDepth.size > 0;
    if (ancestorCollapsed) {
      // If row is an uncategorized one (categoryId = null) it's still a root → never hidden.
      if (row.categoryId !== null) continue;
    }

    const isUncategorized = row.categoryId === null;
    const id = row.categoryId;
    const isRowCollapsed = id != null && rowCollapsed.has(id);
    const ownHasChildren = hasDescendants[i];
    const isChild = parents[i] !== -1;

    // Every row shows own + descendants (except uncategorized which has no
    // children). That keeps parents consistent — "Food" always equals the sum
    // of its sub-rows. Child rows are rendered in muted colour to make it
    // obvious that they're already counted upstream.
    const displayValues = ownHasChildren ? subtreeValues[i] : row.values;
    const displayTotal = ownHasChildren ? subtreeTotal[i] : row.total;

    const rowClasses = ["pivot-row"];
    if (isUncategorized) rowClasses.push("pivot-row--uncat");
    if (isChild) rowClasses.push("pivot-row--child");

    out.push(
      <tr
        key={`row-${sectionKey}-${i}`}
        className={rowClasses.join(" ")}
        style={{ fontSize: `${ROW_FONT_SIZES[Math.min(row.depth, ROW_FONT_SIZES.length - 1)]}px` }}
      >
        <td
          className="pivot-name-cell"
          style={{ paddingLeft: `${10 + row.depth * 18}px` }}
        >
          {ownHasChildren && id != null ? (
            <button
              type="button"
              className="pivot-fold-btn"
              onClick={() => onToggleRow(id)}
              title={isRowCollapsed ? unfoldLabel : foldLabel}
            >
              {isRowCollapsed ? "▸" : "▾"}
            </button>
          ) : (
            <span className="pivot-fold-spacer" aria-hidden />
          )}
          {!isUncategorized && (
            <span
              className="pivot-swatch"
              style={{ background: row.color || "#999" }}
              aria-hidden
            />
          )}
          <span className="pivot-name-text">
            {isUncategorized ? uncategorizedLabel : row.name}
          </span>
        </td>
        {displayValues.map((v, idx) => (
          <td key={idx} className="pivot-value-cell">
            {formatMoney(v)}
          </td>
        ))}
        <td className="pivot-value-cell pivot-value-cell--total">
          {formatMoney(displayTotal)}
        </td>
      </tr>,
    );

    // If this row got collapsed and has descendants, suppress them in subsequent iterations.
    if (isRowCollapsed && ownHasChildren) {
      collapsedAtDepth.set(row.depth, i);
    }
  }

  return out;
}

interface RowAnalysis {
  /** index → index of the row's parent in the rendered list, -1 if root */
  parents: number[];
  /** index → true if this row has at least one descendant in the rendered list */
  hasDescendants: boolean[];
  /** Per-period values, formatted; for non-leaf rows includes own + descendants. */
  subtreeValues: string[][];
  /** Per-period values in minor units (used to recompute section totals). */
  subtreeMinor: number[][];
  subtreeTotal: string[];
  subtreeTotalMinor: number[];
}

function analyzeRows(rows: ReportRow[]): RowAnalysis {
  const children: Map<number, number[]> = new Map();
  const hasDescendants = new Array(rows.length).fill(false) as boolean[];
  const stack: number[] = []; // indices, monotonically increasing depth

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.categoryId === null) {
      // Uncategorized = standalone root, breaks the stack.
      stack.length = 0;
      continue;
    }
    while (stack.length > 0 && rows[stack[stack.length - 1]].depth >= r.depth) {
      stack.pop();
    }
    if (stack.length > 0) {
      const parent = stack[stack.length - 1];
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push(i);
      hasDescendants[parent] = true;
    }
    stack.push(i);
  }

  const nPeriods = rows[0]?.values.length ?? 0;
  const subtreeMinor: number[][] = rows.map((r) =>
    r.values.map((v) => parseMoneyToMinor(v) ?? 0),
  );
  const subtreeTotalMinor: number[] = rows.map((r) => parseMoneyToMinor(r.total) ?? 0);

  // Post-order traversal: process deeper rows first, push their sums into parents.
  // Depth-first walk by going through rows in reverse and adding into parent.
  const parents = new Array(rows.length).fill(-1) as number[];
  for (const [parent, kids] of children.entries()) {
    for (const k of kids) parents[k] = parent;
  }
  // Process by descending depth so children are added to parents before parents
  // get rolled into grandparents.
  const order = rows
    .map((_, i) => i)
    .filter((i) => rows[i].categoryId !== null)
    .sort((a, b) => rows[b].depth - rows[a].depth);
  for (const i of order) {
    const p = parents[i];
    if (p === -1) continue;
    for (let k = 0; k < nPeriods; k++) {
      subtreeMinor[p][k] += subtreeMinor[i][k];
    }
    subtreeTotalMinor[p] += subtreeTotalMinor[i];
  }

  const subtreeValues = subtreeMinor.map((vs) => vs.map((m) => formatMinorAsMoney(m)));
  const subtreeTotal = subtreeTotalMinor.map((m) => formatMinorAsMoney(m));

  return {
    parents,
    hasDescendants,
    subtreeValues,
    subtreeMinor,
    subtreeTotal,
    subtreeTotalMinor,
  };
}
