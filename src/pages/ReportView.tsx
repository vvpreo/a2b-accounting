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
  defaultRange: ReportRange;
  defaultGranularity: Granularity;
  expandedCategoryIds: number[];
}

const DEFAULT_CONFIG: ReportConfigShape = {
  version: 1,
  accountIds: [],
  expenseCategoryIds: [],
  incomeCategoryIds: [],
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
    const parsed = JSON.parse(raw) as Partial<ReportConfigShape>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function ReportViewPage({ view, onEdit }: Props) {
  const t = useT();
  const config = useMemo(() => safeParseConfig(view.config), [view.config]);

  const [range, setRange] = useState<ReportRange>(config.defaultRange);
  const [granularity, setGranularity] = useState<Granularity>(config.defaultGranularity);
  const [showTotal, setShowTotal] = useState(true);

  // Reset runtime controls when switching between saved views.
  useEffect(() => {
    setRange(config.defaultRange);
    setGranularity(config.defaultGranularity);
    setShowTotal(true);
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
        <label className="report-controls-toggle">
          <input
            type="checkbox"
            checked={showTotal}
            onChange={(e) => setShowTotal(e.target.checked)}
          />
          <span>{t("report.showTotalColumn")}</span>
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
          showTotal={showTotal}
        />
      )}
    </section>
  );
}

interface PivotProps {
  response: ReportResponse;
  initialExpanded: number[];
  showTotal: boolean;
}

function PivotTable({ response, initialExpanded, showTotal }: PivotProps) {
  const t = useT();
  const { periods, expense, income } = response;
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [incomeCollapsed, setIncomeCollapsed] = useState(false);
  const [expenseCollapsed, setExpenseCollapsed] = useState(false);

  // Switching to a different view (or recomputing) resets collapse state.
  // Default: collapse every group row (any category that has descendants in
  // the rendered list). The user opens the report and sees roll-ups; they
  // expand individual groups they want to drill into. Section headers stay
  // expanded so the totals are immediately visible.
  useEffect(() => {
    const groupIds = new Set<number>();
    for (const section of [income, expense]) {
      const { hasDescendants } = analyzeRows(section.rows);
      for (let i = 0; i < section.rows.length; i++) {
        if (hasDescendants[i] && section.rows[i].categoryId != null) {
          groupIds.add(section.rows[i].categoryId!);
        }
      }
    }
    setCollapsed(groupIds);
    setIncomeCollapsed(false);
    setExpenseCollapsed(false);
  }, [response, initialExpanded, income, expense]);

  function toggleRow(catId: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }

  // Template carries a literal `{name}` placeholder — substituted per row in
  // renderSection. Calling t() without params returns the raw template.
  const groupNameTemplate = t("report.groupRowName");
  const incomeRows = renderSection({
    section: income,
    sectionKey: "income",
    sectionCollapsed: incomeCollapsed,
    onToggleSection: () => setIncomeCollapsed((v) => !v),
    rowCollapsed: collapsed,
    onToggleRow: toggleRow,
    sectionTitle: t("report.sectionIncome"),
    uncategorizedLabel: t("report.uncategorized"),
    groupNameTemplate,
    foldLabel: t("report.fold"),
    unfoldLabel: t("report.unfold"),
    showTotal,
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
    groupNameTemplate,
    foldLabel: t("report.fold"),
    unfoldLabel: t("report.unfold"),
    showTotal,
  });

  const isEmpty = expense.rows.length === 0 && income.rows.length === 0;

  if (isEmpty) {
    return <div className="report-empty">{t("report.empty")}</div>;
  }

  const metricsRows = renderMetricsSection({
    periods,
    income,
    expense,
    sectionTitle: t("report.sectionMetrics"),
    netLabel: t("report.metricNet"),
    cumulativeLabel: t("report.metricNetCumulative"),
    showTotal,
  });

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
            {showTotal && (
              <th className="pivot-total-col">{t("report.totalColumn")}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {income.rows.length > 0 && incomeRows}
          {expense.rows.length > 0 && expenseRows}
          {metricsRows}
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
  // Template like "ГРУППА ({name})" — applied to the synthetic aggregate row
  // produced for each selected category that has selected children.
  groupNameTemplate: string;
  foldLabel: string;
  unfoldLabel: string;
  showTotal: boolean;
}

// One row in the visual plan. A backend row that has selected descendants is
// rendered as a pair: a "group" row at depth D showing the subtree total, plus
// an "own" row at depth D+1 showing only what was tagged directly to that
// category. That way every group's number on screen equals the sum of the
// nested visible rows below it — no rolled-up "magic" amounts.
interface PlanRow {
  kind: "group" | "own" | "leaf" | "uncat";
  // The original backend row index this plan entry was derived from. Used by
  // the collapse logic to look up the category id and fold state.
  sourceIdx: number;
  depth: number;
  values: string[];
  total: string;
  // Whether this entry can be collapsed (group rows only).
  collapsible: boolean;
}

function buildPlan(
  rows: ReportRow[],
  hasDescendants: boolean[],
  subtreeValues: string[][],
  subtreeTotal: string[],
): PlanRow[] {
  const out: PlanRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.categoryId === null) {
      out.push({ kind: "uncat", sourceIdx: i, depth: 0, values: row.values, total: row.total, collapsible: false });
      continue;
    }
    if (hasDescendants[i]) {
      // Group row at the original depth — carries the subtree total and is
      // foldable.
      out.push({
        kind: "group",
        sourceIdx: i,
        depth: row.depth,
        values: subtreeValues[i],
        total: subtreeTotal[i],
        collapsible: true,
      });
      // Own row always rendered, even when zero — the user wants the
      // "directly tagged on this group" line visible for consistency, so the
      // sum of visible nested rows always equals the group total.
      out.push({
        kind: "own",
        sourceIdx: i,
        depth: row.depth + 1,
        values: row.values,
        total: row.total,
        collapsible: false,
      });
    } else {
      out.push({
        kind: "leaf",
        sourceIdx: i,
        depth: row.depth,
        values: row.values,
        total: row.total,
        collapsible: false,
      });
    }
  }
  return out;
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
  groupNameTemplate,
  foldLabel,
  unfoldLabel,
  showTotal,
}: RenderSectionArgs): React.ReactElement[] {
  const { rows } = section;
  const { parents, hasDescendants, subtreeValues, subtreeMinor, subtreeTotal, subtreeTotalMinor } =
    analyzeRows(rows);

  // Section totals are the sum of *root rows only* — every selected category
  // either lands directly in its row (leaf) or is rolled into its group row,
  // so summing roots covers the section without double-counting.
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
      {showTotal && (
        <td className="pivot-value-cell pivot-value-cell--total">
          {formatMoney(sectionTotalStr)}
        </td>
      )}
    </tr>,
  );

  if (sectionCollapsed) {
    return out;
  }

  const plan = buildPlan(rows, hasDescendants, subtreeValues, subtreeTotal);

  // Walk plan entries in order; collapse stack works on plan depths, since
  // group/own rows live at different depths than backend rows would suggest.
  const collapsedAtDepth: Map<number, number> = new Map();
  for (let pi = 0; pi < plan.length; pi++) {
    const entry = plan[pi];
    for (const d of Array.from(collapsedAtDepth.keys())) {
      if (d >= entry.depth) collapsedAtDepth.delete(d);
    }
    const ancestorCollapsed = collapsedAtDepth.size > 0;
    if (ancestorCollapsed && entry.kind !== "uncat") continue;

    const sourceRow = rows[entry.sourceIdx];
    const isUncat = entry.kind === "uncat";
    const isGroup = entry.kind === "group";
    const id = sourceRow.categoryId;
    const isCollapsed = isGroup && id != null && rowCollapsed.has(id);

    const rowClasses = ["pivot-row"];
    if (isUncat) rowClasses.push("pivot-row--uncat");
    if (isGroup) rowClasses.push("pivot-row--group");
    if (entry.kind === "own") rowClasses.push("pivot-row--own");

    out.push(
      <tr
        key={`row-${sectionKey}-${pi}`}
        className={rowClasses.join(" ")}
        style={{ fontSize: `${ROW_FONT_SIZES[Math.min(entry.depth, ROW_FONT_SIZES.length - 1)]}px` }}
      >
        <td
          className="pivot-name-cell"
          style={{ paddingLeft: `${12 + entry.depth * 22}px` }}
        >
          {entry.collapsible && id != null ? (
            <button
              type="button"
              className="pivot-fold-btn"
              onClick={() => onToggleRow(id)}
              title={isCollapsed ? unfoldLabel : foldLabel}
            >
              {isCollapsed ? "▸" : "▾"}
            </button>
          ) : (
            <span className="pivot-fold-spacer" aria-hidden />
          )}
          {!isUncat && (
            <span
              className="pivot-swatch"
              style={{ background: sourceRow.color || "#999" }}
              aria-hidden
            />
          )}
          <span className="pivot-name-text">
            {isUncat
              ? uncategorizedLabel
              : isGroup
              ? groupNameTemplate.replace("{name}", sourceRow.name)
              : sourceRow.name}
          </span>
        </td>
        {entry.values.map((v, idx) => (
          <td key={idx} className="pivot-value-cell">
            {formatMoney(v)}
          </td>
        ))}
        {showTotal && (
          <td className="pivot-value-cell pivot-value-cell--total">
            {formatMoney(entry.total)}
          </td>
        )}
      </tr>,
    );

    if (isCollapsed && entry.collapsible) {
      collapsedAtDepth.set(entry.depth, entry.sourceIdx);
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

interface RenderMetricsArgs {
  periods: ReportResponse["periods"];
  income: SectionData;
  expense: SectionData;
  sectionTitle: string;
  netLabel: string;
  cumulativeLabel: string;
  showTotal: boolean;
}

// Sums every row's per-period values. Backend allocates each transaction share
// to exactly one row (selected category or uncategorized), so summing every row
// equals the section total — no double-counting from parent/child duplication.
function sumSectionPerPeriodMinor(rows: ReportRow[], nPeriods: number): number[] {
  const out = new Array<number>(nPeriods).fill(0);
  for (const r of rows) {
    for (let k = 0; k < nPeriods; k++) {
      out[k] += parseMoneyToMinor(r.values[k]) ?? 0;
    }
  }
  return out;
}

function signClass(minor: number): string {
  if (minor > 0) return "pivot-value-cell--positive";
  if (minor < 0) return "pivot-value-cell--negative";
  return "";
}

function renderMetricsSection({
  periods,
  income,
  expense,
  sectionTitle,
  netLabel,
  cumulativeLabel,
  showTotal,
}: RenderMetricsArgs): React.ReactElement[] {
  const nPeriods = periods.length;
  const incomePerPeriod = sumSectionPerPeriodMinor(income.rows, nPeriods);
  const expensePerPeriod = sumSectionPerPeriodMinor(expense.rows, nPeriods);

  const netPerPeriod = incomePerPeriod.map((inc, k) => inc - expensePerPeriod[k]);
  const netTotal = netPerPeriod.reduce((a, b) => a + b, 0);

  // Cumulative = running net from the start of the range. The total column
  // mirrors the final cumulative — that's the answer to "am I in the green
  // for this whole period?".
  const cumulativePerPeriod: number[] = [];
  let acc = 0;
  for (const v of netPerPeriod) {
    acc += v;
    cumulativePerPeriod.push(acc);
  }
  const cumulativeTotal = acc;

  const renderRow = (
    key: string,
    label: string,
    values: number[],
    total: number,
  ): React.ReactElement => (
    <tr key={key} className="pivot-row pivot-row--metric">
      <td className="pivot-name-cell">
        <span className="pivot-fold-spacer" aria-hidden />
        <span className="pivot-name-text">{label}</span>
      </td>
      {values.map((m, idx) => (
        <td key={idx} className={`pivot-value-cell ${signClass(m)}`.trim()}>
          {formatMoney(formatMinorAsMoney(m))}
        </td>
      ))}
      {showTotal && (
        <td
          className={`pivot-value-cell pivot-value-cell--total ${signClass(total)}`.trim()}
        >
          {formatMoney(formatMinorAsMoney(total))}
        </td>
      )}
    </tr>
  );

  return [
    <tr key="header-metrics" className="pivot-row pivot-row--section">
      <td className="pivot-name-cell pivot-name-cell--section">
        <span className="pivot-fold-spacer" aria-hidden />
        <span className="pivot-name-text">{sectionTitle}</span>
      </td>
      {periods.map((_, idx) => (
        <td key={idx} className="pivot-value-cell" />
      ))}
      {showTotal && <td className="pivot-value-cell pivot-value-cell--total" />}
    </tr>,
    renderRow("metric-net", netLabel, netPerPeriod, netTotal),
    renderRow("metric-cumulative", cumulativeLabel, cumulativePerPeriod, cumulativeTotal),
  ];
}
