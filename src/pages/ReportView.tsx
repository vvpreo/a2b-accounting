import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { MultiSelectDropdown } from "../components/MultiSelectDropdown";
import { useT } from "../i18n";
import {
  Account,
  ALL_METRIC_KEYS,
  BalanceMetrics,
  Category,
  CellTarget,
  computeReport,
  firstTransactionDate,
  Granularity,
  InternalTransferMetrics,
  listAccounts,
  listCategories,
  MetricKey,
  RangePreset,
  ReportConfig,
  ReportRange,
  ReportRequest,
  ReportResponse,
  ReportRow,
  ReportView,
  SectionData,
  updateReportView,
} from "../lib/api";
import { formatMinorAsMoney, formatMoney, parseMoneyToMinor } from "../lib/money";
import { CategoryPickerModal, computeInitialOrder } from "./report/CategoryPicker";
import { CellTransactionsModal } from "./report/CellTransactionsModal";

// Everything the drill-down modal needs about a clicked cell: the backend
// target plus display labels echoed in the modal header.
export interface CellClickInfo {
  target: CellTarget;
  categoryLabel: string;
  periodLabel: string;
  sectionKind: "income" | "expense";
  amount: string;
}

interface Props {
  view: ReportView;
  onSaved: (view: ReportView) => void;
}

const DEFAULT_CONFIG: ReportConfig = {
  version: 1,
  accountIds: [],
  expenseCategoryIds: [],
  incomeCategoryIds: [],
  defaultRange: { kind: "preset", preset: "current_year" },
  defaultGranularity: "month",
  expandedCategoryIds: [],
  showTotalColumn: true,
  showZeroRows: false,
  visibleMetrics: ALL_METRIC_KEYS,
};

// Legacy compat: older configs persisted the inverse `hideZeroRows` flag.
// Prefer the new field, then fall back to inverted legacy, then default to
// `false` (don't show zero rows) for brand-new reports.
function resolveShowZeroRows(cfg: ReportConfig): boolean {
  if (cfg.showZeroRows !== undefined) return cfg.showZeroRows;
  if (cfg.hideZeroRows !== undefined) return !cfg.hideZeroRows;
  return false;
}

// Sanitize the persisted set: drop unknown keys, dedupe, preserve canonical
// rendering order. Older configs without the field default to all metrics
// visible — that's the most discoverable behavior for users opening a
// pre-existing report after this feature ships.
function normalizeVisibleMetrics(raw: MetricKey[] | undefined): MetricKey[] {
  if (!raw) return [...ALL_METRIC_KEYS];
  const allowed = new Set<MetricKey>(ALL_METRIC_KEYS);
  const seen = new Set<MetricKey>();
  for (const key of raw) {
    if (allowed.has(key)) seen.add(key);
  }
  return ALL_METRIC_KEYS.filter((k) => seen.has(k));
}

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

// Debounce window for the auto-save: long enough that typing the report name
// produces one save instead of one-per-keystroke; short enough that toggles
// feel persistent within a beat.
const AUTOSAVE_DELAY_MS = 500;

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

function resolveRange(
  range: ReportRange,
  // Earliest transaction date for the active account selection. When the
  // "all_time" preset is chosen we anchor `from` here so the report doesn't
  // start at 1970 and pad with thousands of empty periods. `null` while still
  // loading or when there are no transactions — fallback to a small window
  // around today instead of 1970.
  earliestTxnDate: string | null,
): { from: string; to: string } | null {
  if (range.kind === "custom") return { from: range.from, to: range.to };
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  const todayStr = isoDate(y, m, today.getDate());
  // Cap any built-in preset's upper bound at today — there's no point
  // padding the report with empty future periods (May–Dec when we're in
  // April), and the user can always switch to "custom" to look ahead.
  const capToToday = (to: string): string => (to > todayStr ? todayStr : to);
  switch (range.preset) {
    case "current_month":
      return {
        from: isoDate(y, m, 1),
        to: capToToday(isoDate(y, m, lastDayOfMonth(y, m))),
      };
    case "current_quarter": {
      const qStart = Math.floor((m - 1) / 3) * 3 + 1;
      const qEnd = qStart + 2;
      return {
        from: isoDate(y, qStart, 1),
        to: capToToday(isoDate(y, qEnd, lastDayOfMonth(y, qEnd))),
      };
    }
    case "current_year":
      return { from: isoDate(y, 1, 1), to: capToToday(isoDate(y, 12, 31)) };
    case "last_12_months": {
      const start = new Date(y, m - 12, 1);
      return {
        from: isoDate(start.getFullYear(), start.getMonth() + 1, 1),
        to: capToToday(isoDate(y, m, lastDayOfMonth(y, m))),
      };
    }
    case "all_time": {
      if (earliestTxnDate === null) {
        // Hold off computing the report until we know where the data starts.
        // Returning null here means the effect skips the computeReport call;
        // it'll re-run when earliestTxnDate arrives.
        return null;
      }
      return { from: earliestTxnDate, to: todayStr };
    }
  }
}

function safeParseConfig(raw: string): ReportConfig {
  try {
    const parsed = JSON.parse(raw) as Partial<ReportConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function ReportViewPage({ view, onSaved }: Props) {
  const t = useT();
  const initialConfig = useMemo(() => safeParseConfig(view.config), [view.config]);

  // Every panel field is editable AND auto-persisted. The pivot below renders
  // off the *current* state, not the saved one — so changes apply immediately
  // and a debounced background save commits them to the backend.
  const [name, setName] = useState(view.name);
  const [accountIds, setAccountIds] = useState<number[]>(initialConfig.accountIds);
  const [range, setRange] = useState<ReportRange>(initialConfig.defaultRange);
  const [granularity, setGranularity] = useState<Granularity>(initialConfig.defaultGranularity);
  const [showTotal, setShowTotal] = useState(initialConfig.showTotalColumn ?? true);
  const [showZeroRows, setShowZeroRows] = useState(() =>
    resolveShowZeroRows(initialConfig),
  );
  const [visibleMetrics, setVisibleMetrics] = useState<MetricKey[]>(() =>
    normalizeVisibleMetrics(initialConfig.visibleMetrics),
  );
  const [expenseOrder, setExpenseOrder] = useState<number[]>([]);
  const [expenseSelected, setExpenseSelected] = useState<Set<number>>(new Set());
  const [incomeOrder, setIncomeOrder] = useState<number[]>([]);
  const [incomeSelected, setIncomeSelected] = useState<Set<number>>(new Set());

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);

  const [filtersExpanded, setFiltersExpanded] = useState(true);
  // One picker per kind — opened from the gear icon in the corresponding
  // section header. Local state inside each modal owns pending edits and
  // commits via Save; ESC/cancel discards.
  const [expensePickerOpen, setExpensePickerOpen] = useState(false);
  const [incomePickerOpen, setIncomePickerOpen] = useState(false);
  // Toggles the metrics-visibility settings modal opened from the section
  // header's gear icon.
  const [metricsSettingsOpen, setMetricsSettingsOpen] = useState(false);

  // The report cell the user clicked, if any — drives the transaction
  // drill-down modal. `null` while closed.
  const [cellModal, setCellModal] = useState<CellClickInfo | null>(null);

  const [response, setResponse] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Earliest transaction date among the currently selected accounts. Used to
  // anchor the "all_time" preset's `from`. Re-queried whenever the account
  // selection changes so swapping accounts in/out updates the boundary.
  const [earliestTxnDate, setEarliestTxnDate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEarliestTxnDate(null);
    firstTransactionDate(accountIds.length > 0 ? accountIds : undefined)
      .then((d) => {
        if (!cancelled) setEarliestTxnDate(d);
      })
      .catch(() => {
        if (!cancelled) setEarliestTxnDate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accountIds]);

  // Load accounts + categories once.
  useEffect(() => {
    let cancelled = false;
    listAccounts()
      .then((a) => {
        if (!cancelled) {
          setAccounts(a);
          setAccountsLoaded(true);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    listCategories()
      .then((c) => {
        if (!cancelled) {
          setCategories(c);
          setCategoriesLoaded(true);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Whenever we land on a different saved view, or once categories arrive,
  // hydrate the form state from the persisted config. We deliberately read
  // `initialConfig` here instead of view.config so the deep equality of the
  // memoised config drives this reset.
  useEffect(() => {
    if (!categoriesLoaded) return;
    const expCats = categories.filter((c) => c.kind === "expense");
    const incCats = categories.filter((c) => c.kind === "income");
    setName(view.name);
    setAccountIds(initialConfig.accountIds);
    setRange(initialConfig.defaultRange);
    setGranularity(initialConfig.defaultGranularity);
    setShowTotal(initialConfig.showTotalColumn ?? true);
    setShowZeroRows(resolveShowZeroRows(initialConfig));
    setVisibleMetrics(normalizeVisibleMetrics(initialConfig.visibleMetrics));
    setExpenseOrder(
      computeInitialOrder(
        expCats,
        initialConfig.expenseCategoryOrder ?? initialConfig.expenseCategoryIds,
      ),
    );
    setExpenseSelected(new Set(initialConfig.expenseCategoryIds));
    setIncomeOrder(
      computeInitialOrder(
        incCats,
        initialConfig.incomeCategoryOrder ?? initialConfig.incomeCategoryIds,
      ),
    );
    setIncomeSelected(new Set(initialConfig.incomeCategoryIds));
  }, [view.id, view.name, initialConfig, categoriesLoaded, categories]);

  // The exact request that produces the currently displayed report. Memoized
  // so the cell drill-down modal can replay the same scope/filters and get a
  // transaction list consistent with the rendered numbers.
  const reportRequest = useMemo<ReportRequest | null>(() => {
    const resolved = resolveRange(range, earliestTxnDate);
    if (!resolved) return null;
    const { from, to } = resolved;
    if (!from || !to || to < from) return null;
    return {
      accountIds,
      expenseCategoryIds: expenseOrder.filter((id) => expenseSelected.has(id)),
      incomeCategoryIds: incomeOrder.filter((id) => incomeSelected.has(id)),
      from,
      to,
      granularity,
    };
  }, [
    range,
    earliestTxnDate,
    accountIds,
    expenseOrder,
    expenseSelected,
    incomeOrder,
    incomeSelected,
    granularity,
  ]);

  // Recompute the report whenever the resolved request changes.
  useEffect(() => {
    if (!reportRequest) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    computeReport(reportRequest)
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
  }, [reportRequest]);

  // ---- auto-save ----
  // We persist the active form state to the backend on a short debounce. The
  // initial hydrate (above) flips `hydrated` true, so the very first effect
  // pass after hydration doesn't trigger a no-op save.
  const hydratedRef = useRef(false);
  const lastSavedRef = useRef<{ name: string; payload: string } | null>(null);
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // Wait until both accounts and categories are loaded so the form has
    // valid baseline state before we start emitting saves.
    if (!accountsLoaded || !categoriesLoaded) return;
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      const expenseSelOrdered = expenseOrder.filter((id) => expenseSelected.has(id));
      const incomeSelOrdered = incomeOrder.filter((id) => incomeSelected.has(id));
      const config: ReportConfig = {
        version: 1,
        accountIds,
        expenseCategoryIds: expenseSelOrdered,
        incomeCategoryIds: incomeSelOrdered,
        expenseCategoryOrder: expenseOrder,
        incomeCategoryOrder: incomeOrder,
        defaultRange: range,
        defaultGranularity: granularity,
        expandedCategoryIds: initialConfig.expandedCategoryIds,
        showTotalColumn: showTotal,
        showZeroRows,
        visibleMetrics,
      };
      lastSavedRef.current = { name, payload: JSON.stringify(config) };
      return;
    }

    const expenseSelOrdered = expenseOrder.filter((id) => expenseSelected.has(id));
    const incomeSelOrdered = incomeOrder.filter((id) => incomeSelected.has(id));
    const config: ReportConfig = {
      version: 1,
      accountIds,
      expenseCategoryIds: expenseSelOrdered,
      incomeCategoryIds: incomeSelOrdered,
      expenseCategoryOrder: expenseOrder,
      incomeCategoryOrder: incomeOrder,
      defaultRange: range,
      defaultGranularity: granularity,
      expandedCategoryIds: initialConfig.expandedCategoryIds,
      showTotalColumn: showTotal,
      showZeroRows,
      visibleMetrics,
    };
    const payload = JSON.stringify(config);
    const trimmedName = name.trim() || view.name;

    const last = lastSavedRef.current;
    if (last && last.name === trimmedName && last.payload === payload) {
      return;
    }

    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      updateReportView({ id: view.id, name: trimmedName, config: payload })
        .then((saved) => {
          lastSavedRef.current = { name: trimmedName, payload };
          setSaveError(null);
          onSaved(saved);
        })
        .catch((e) => setSaveError(String(e)));
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [
    accountsLoaded,
    categoriesLoaded,
    name,
    accountIds,
    range,
    granularity,
    showTotal,
    showZeroRows,
    visibleMetrics,
    expenseOrder,
    expenseSelected,
    incomeOrder,
    incomeSelected,
    view.id,
    view.name,
    initialConfig.expandedCategoryIds,
    onSaved,
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

  const accountItems = accounts.map((a) => ({
    id: a.id,
    label: `${a.name || a.accountNumber || `#${a.id}`} · ${a.currency}`,
  }));

  // id → display label, shared with the cell drill-down modal.
  const accountNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of accounts) {
      m.set(a.id, `${a.name || a.accountNumber || `#${a.id}`} · ${a.currency}`);
    }
    return m;
  }, [accounts]);

  // Display options collapsed into a single multi-select dropdown — keeps
  // the toolbar compact even as we add more boolean toggles. The dropdown's
  // "selected" array is the projection of the underlying booleans; on apply
  // we splat them back into individual state setters.
  const displayItems = [
    { id: "totalColumn", label: t("report.showTotalColumn") },
    { id: "zeroRows", label: t("report.showZeroRows") },
  ];
  const displaySelected: string[] = [];
  if (showTotal) displaySelected.push("totalColumn");
  if (showZeroRows) displaySelected.push("zeroRows");

  return (
    <section className="page report-page">
      <section
        className={`filter-bar${filtersExpanded ? "" : " filter-bar--collapsed"}`}
      >
        <button
          type="button"
          className="filter-bar-handle"
          onClick={() => setFiltersExpanded((v) => !v)}
          aria-label={
            filtersExpanded ? t("toolbar.collapse") : t("toolbar.expand")
          }
          title={
            filtersExpanded ? t("toolbar.collapse") : t("toolbar.expand")
          }
        >
          <span className="filter-bar-handle-grip" />
        </button>
        {filtersExpanded && (
          <div className="filter-bar-row report-filter-bar-row">
            <label className="filter-field">
              <span>{t("builder.fieldName")}</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("builder.fieldNamePlaceholder")}
                autoComplete="off"
              />
            </label>
            <label className="filter-field">
              <span>{t("builder.accountsLabel")}</span>
              <MultiSelectDropdown<number>
                items={accountItems}
                selected={accountIds}
                onApply={setAccountIds}
                allLabel={t("builder.accountsAll")}
                noneLabel={t("builder.accountsNone")}
                emptyItemsLabel={t("builder.accountsEmpty")}
                multiSelectedLabel={(count) => t("builder.accountsMany", { count })}
                applyLabel={t("builder.accountsApply")}
              />
            </label>
            <label className="filter-field">
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
                <label className="filter-field">
                  <span>{t("report.fromDate")}</span>
                  <input
                    type="date"
                    value={range.from}
                    onChange={(e) => setRange({ ...range, from: e.target.value })}
                  />
                </label>
                <label className="filter-field">
                  <span>{t("report.toDate")}</span>
                  <input
                    type="date"
                    value={range.to}
                    onChange={(e) => setRange({ ...range, to: e.target.value })}
                  />
                </label>
              </>
            )}
            <label className="filter-field">
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
            <label className="filter-field">
              <span>{t("report.displayLabel")}</span>
              <MultiSelectDropdown<string>
                items={displayItems}
                selected={displaySelected}
                onApply={(next) => {
                  setShowTotal(next.includes("totalColumn"));
                  setShowZeroRows(next.includes("zeroRows"));
                }}
                allLabel={t("report.displayAll")}
                noneLabel={t("report.displayNone")}
                emptyItemsLabel={t("report.displayNone")}
                multiSelectedLabel={(count) =>
                  t("report.displayMany", { count })
                }
                applyLabel={t("report.displayApply")}
                showSelectAll={false}
              />
            </label>
          </div>
        )}
      </section>

      {incomePickerOpen && (
        <CategoryPickerModal
          title={t("report.incomeCategoriesTitle")}
          sectionTitle={t("report.incomeCategoriesTitle")}
          kind="income"
          categories={categories}
          initial={{ order: incomeOrder, selected: incomeSelected }}
          onCancel={() => setIncomePickerOpen(false)}
          onSave={(next) => {
            setIncomeOrder(next.order);
            setIncomeSelected(next.selected);
            setIncomePickerOpen(false);
          }}
        />
      )}

      {expensePickerOpen && (
        <CategoryPickerModal
          title={t("report.expenseCategoriesTitle")}
          sectionTitle={t("report.expenseCategoriesTitle")}
          kind="expense"
          categories={categories}
          initial={{ order: expenseOrder, selected: expenseSelected }}
          onCancel={() => setExpensePickerOpen(false)}
          onSave={(next) => {
            setExpenseOrder(next.order);
            setExpenseSelected(next.selected);
            setExpensePickerOpen(false);
          }}
        />
      )}

      {saveError && (
        <div className="error">{saveError}</div>
      )}
      {error && (
        <div className="error">{t("report.errorLoading", { message: error })}</div>
      )}
      {loading && !response && <div className="report-loading">{t("report.loading")}</div>}

      {response && (
        <PivotTable
          response={response}
          initialExpanded={initialConfig.expandedCategoryIds}
          showTotal={showTotal}
          showZeroRows={showZeroRows}
          visibleMetrics={visibleMetrics}
          onOpenMetricsSettings={() => setMetricsSettingsOpen(true)}
          onOpenIncomeSettings={() => setIncomePickerOpen(true)}
          onOpenExpenseSettings={() => setExpensePickerOpen(true)}
          onCellClick={setCellModal}
        />
      )}

      {cellModal && reportRequest && (
        <CellTransactionsModal
          request={reportRequest}
          info={cellModal}
          accountNameById={accountNameById}
          onClose={() => setCellModal(null)}
        />
      )}

      {metricsSettingsOpen && (
        <MetricsSettingsModal
          initial={visibleMetrics}
          onCancel={() => setMetricsSettingsOpen(false)}
          onSave={(next) => {
            setVisibleMetrics(next);
            setMetricsSettingsOpen(false);
          }}
        />
      )}
    </section>
  );
}

interface PivotProps {
  response: ReportResponse;
  initialExpanded: number[];
  showTotal: boolean;
  // When false, income/expense rows whose every value is zero (in minor
  // units) are dropped before render. The section header is always shown
  // (even with all-zero totals) so the gear icon stays accessible. Metrics
  // rows are unaffected.
  showZeroRows: boolean;
  visibleMetrics: MetricKey[];
  onOpenMetricsSettings: () => void;
  // Open per-kind category picker modals — wired into the gear button in
  // each section's header.
  onOpenIncomeSettings: () => void;
  onOpenExpenseSettings: () => void;
  // Fired when the user clicks a category/uncategorized value cell (or the
  // Total column). Opens the transaction drill-down modal.
  onCellClick: (info: CellClickInfo) => void;
}

function PivotTable({
  response,
  initialExpanded,
  showTotal,
  showZeroRows,
  visibleMetrics,
  onOpenMetricsSettings,
  onOpenIncomeSettings,
  onOpenExpenseSettings,
  onCellClick,
}: PivotProps) {
  const t = useT();
  const { periods, expense, income, balances, internalTransfers } = response;
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [incomeCollapsed, setIncomeCollapsed] = useState(false);
  const [expenseCollapsed, setExpenseCollapsed] = useState(false);
  const [metricsCollapsed, setMetricsCollapsed] = useState(false);

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
    setMetricsCollapsed(false);
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
  const nPeriods = periods.length;
  const totalLabel = t("report.totalColumn");
  const incomeRows = renderSection({
    section: income,
    sectionKey: "income",
    nPeriods,
    periods,
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
    showZeroRows,
    onOpenSettings: onOpenIncomeSettings,
    settingsLabel: t("report.incomeCategoriesSettings"),
    onCellClick,
    totalLabel,
  });
  const expenseRows = renderSection({
    section: expense,
    sectionKey: "expense",
    nPeriods,
    periods,
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
    showZeroRows,
    onOpenSettings: onOpenExpenseSettings,
    settingsLabel: t("report.expenseCategoriesSettings"),
    onCellClick,
    totalLabel,
  });

  const metricsRows = renderMetricsSection({
    periods,
    income,
    expense,
    balances,
    internalTransfers,
    visibleMetrics,
    sectionTitle: t("report.sectionMetrics"),
    netLabel: t("report.metricNet"),
    cumulativeLabel: t("report.metricNetCumulative"),
    openingLabel: t("report.metricOpeningBalance"),
    closingLabel: t("report.metricClosingBalance"),
    internalTransferOutLabel: t("report.metricInternalTransferOut"),
    internalTransferInLabel: t("report.metricInternalTransferIn"),
    settingsLabel: t("report.metricsSettings"),
    onOpenSettings: onOpenMetricsSettings,
    showTotal,
    sectionCollapsed: metricsCollapsed,
    onToggleSection: () => setMetricsCollapsed((v) => !v),
    foldLabel: t("report.fold"),
    unfoldLabel: t("report.unfold"),
  });

  // Hide the metrics section entirely when the user has unticked every
  // metric — there's nothing to show, just the empty header would be noise.
  const showMetrics = visibleMetrics.length > 0;

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
          {incomeRows}
          {expenseRows}
          {showMetrics && metricsRows}
        </tbody>
      </table>
    </div>
  );
}

interface RenderSectionArgs {
  section: SectionData;
  sectionKey: string;
  // Authoritative period count from `response.periods`. Used to size the
  // header's per-period cells when the section has zero rows (in which case
  // we can't infer the column count from `rows[0]`).
  nPeriods: number;
  // Period columns — needed to map a clicked value cell back to its period key
  // and label for the drill-down modal.
  periods: ReportResponse["periods"];
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
  // When false, rows whose subtree (group) or own (leaf/own/uncat) total is
  // zero are dropped from the body. The header is always rendered so the
  // gear icon stays accessible.
  showZeroRows: boolean;
  // Wired to the gear button in the section header. When provided, the
  // button renders next to the title and clicks open a per-kind picker
  // modal upstream. Optional — older callers can omit both fields.
  onOpenSettings?: () => void;
  settingsLabel?: string;
  // Opens the transaction drill-down modal for a clicked value/Total cell.
  onCellClick: (info: CellClickInfo) => void;
  // Label for the rightmost "Итого" column, echoed in the modal header when a
  // Total cell is clicked.
  totalLabel: string;
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
  nPeriods,
  periods,
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
  showZeroRows,
  onOpenSettings,
  settingsLabel,
  onCellClick,
  totalLabel,
}: RenderSectionArgs): React.ReactElement[] {
  const { rows } = section;
  const { parents, hasDescendants, subtreeValues, subtreeMinor, subtreeTotal, subtreeTotalMinor } =
    analyzeRows(rows);

  // Section totals are the sum of *root rows only* — every selected category
  // either lands directly in its row (leaf) or is rolled into its group row,
  // so summing roots covers the section without double-counting.
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
  // Section header — always rendered so the gear icon for category settings
  // stays reachable even when the section has zero data. Clicking the title
  // cell toggles the section fold. The gear sits inside the title cell and
  // stops click propagation to avoid triggering the fold toggle.
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
        {onOpenSettings && (
          <button
            type="button"
            className="pivot-section-settings-btn"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSettings();
            }}
            aria-label={settingsLabel}
            title={settingsLabel}
          >
            ⚙
          </button>
        )}
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

    // Drop rows whose displayed total is zero unless the user has opted in
    // to seeing them. For "group" entries this is the subtree total —
    // skipping here also skips registering the row in collapsedAtDepth, but
    // that's fine: every descendant inherits a zero total (income/expense
    // values are non-negative), so each one is tested independently and
    // skipped on its own merits.
    if (!showZeroRows && (parseMoneyToMinor(entry.total) ?? 0) === 0) {
      continue;
    }

    const sourceRow = rows[entry.sourceIdx];
    const isUncat = entry.kind === "uncat";
    const isGroup = entry.kind === "group";
    const id = sourceRow.categoryId;
    const isCollapsed = isGroup && id != null && rowCollapsed.has(id);

    const rowClasses = ["pivot-row"];
    if (isUncat) rowClasses.push("pivot-row--uncat");
    if (isGroup) rowClasses.push("pivot-row--group");
    if (entry.kind === "own") rowClasses.push("pivot-row--own");

    const displayName = isUncat
      ? uncategorizedLabel
      : isGroup
      ? groupNameTemplate.replace("{name}", sourceRow.name)
      : sourceRow.name;

    // Build the drill-down payload for a value/Total cell. `periodKey === null`
    // targets the whole range (the "Итого" column).
    const sectionKind = sectionKey as "income" | "expense";
    const makeCellInfo = (
      periodKey: string | null,
      periodLabel: string,
      amount: string,
    ): CellClickInfo => ({
      target: {
        section: sectionKind,
        categoryId: isUncat ? null : sourceRow.categoryId,
        includeSubtree: isGroup,
        periodKey,
      },
      categoryLabel: displayName,
      periodLabel,
      sectionKind,
      amount,
    });

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
          <span className="pivot-name-text">{displayName}</span>
        </td>
        {entry.values.map((v, idx) => {
          const clickable = (parseMoneyToMinor(v) ?? 0) !== 0;
          const period = periods[idx];
          return (
            <td
              key={idx}
              className={
                clickable
                  ? "pivot-value-cell pivot-value-cell--clickable"
                  : "pivot-value-cell"
              }
              onClick={
                clickable && period
                  ? () =>
                      onCellClick(
                        makeCellInfo(period.key, period.label, formatMoney(v)),
                      )
                  : undefined
              }
            >
              {formatMoney(v)}
            </td>
          );
        })}
        {showTotal &&
          (() => {
            const clickable = (parseMoneyToMinor(entry.total) ?? 0) !== 0;
            return (
              <td
                className={
                  clickable
                    ? "pivot-value-cell pivot-value-cell--total pivot-value-cell--clickable"
                    : "pivot-value-cell pivot-value-cell--total"
                }
                onClick={
                  clickable
                    ? () =>
                        onCellClick(
                          makeCellInfo(null, totalLabel, formatMoney(entry.total)),
                        )
                    : undefined
                }
              >
                {formatMoney(entry.total)}
              </td>
            );
          })()}
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
  // Backend-provided per-period running balances. Already aggregated across
  // selected accounts and currency-summed 1:1; rendered straight through.
  balances: BalanceMetrics;
  // Per-period sums of transactions netted out by paired internal-transfer
  // links. Surfaced as two informational metric rows so the user sees the
  // volume that didn't reach income/expense.
  internalTransfers: InternalTransferMetrics;
  // Subset of metric keys (in canonical order) the user wants to see. Order
  // here is informational — the renderer follows ALL_METRIC_KEYS for stable
  // visual ordering regardless of selection order.
  visibleMetrics: MetricKey[];
  sectionTitle: string;
  netLabel: string;
  cumulativeLabel: string;
  openingLabel: string;
  closingLabel: string;
  internalTransferOutLabel: string;
  internalTransferInLabel: string;
  // Tooltip + aria-label for the gear icon in the section header that opens
  // the metrics-visibility modal.
  settingsLabel: string;
  onOpenSettings: () => void;
  showTotal: boolean;
  sectionCollapsed: boolean;
  onToggleSection: () => void;
  foldLabel: string;
  unfoldLabel: string;
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
  balances,
  internalTransfers,
  visibleMetrics,
  sectionTitle,
  netLabel,
  cumulativeLabel,
  openingLabel,
  closingLabel,
  internalTransferOutLabel,
  internalTransferInLabel,
  settingsLabel,
  onOpenSettings,
  showTotal,
  sectionCollapsed,
  onToggleSection,
  foldLabel,
  unfoldLabel,
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

  // Balances arrive as money strings (formatted server-side); convert back to
  // minor for the existing sign-class + formatter pipeline. Total column for
  // these two metrics is "first opening" / "last closing" — the deltas
  // bracketing the entire range, not a sum.
  const openingPerPeriod = balances.opening.map(
    (s) => parseMoneyToMinor(s) ?? 0,
  );
  const closingPerPeriod = balances.closing.map(
    (s) => parseMoneyToMinor(s) ?? 0,
  );
  const openingTotal = openingPerPeriod[0] ?? 0;
  const closingTotal = closingPerPeriod[closingPerPeriod.length - 1] ?? 0;

  // Internal transfer metrics are presented as positive amounts (matching the
  // unsigned formatting used in income/expense rows), since they're volume
  // indicators rather than a financial result.
  const transferOutflows = internalTransfers.outflows.map(
    (s) => parseMoneyToMinor(s) ?? 0,
  );
  const transferInflows = internalTransfers.inflows.map(
    (s) => parseMoneyToMinor(s) ?? 0,
  );
  const transferOutflowsTotal = transferOutflows.reduce((a, b) => a + b, 0);
  const transferInflowsTotal = transferInflows.reduce((a, b) => a + b, 0);

  const visibleSet = new Set(visibleMetrics);

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

  // Section header doubles as the fold toggle, mirroring the income/expense
  // headers so the metric block reads as the same kind of section. The gear
  // icon sits inside the title cell — clicking it opens the visibility modal
  // but must not also toggle the section fold (stopPropagation).
  const out: React.ReactElement[] = [
    <tr key="header-metrics" className="pivot-row pivot-row--section">
      <td
        className="pivot-name-cell pivot-name-cell--section"
        onClick={onToggleSection}
        title={sectionCollapsed ? unfoldLabel : foldLabel}
      >
        <span className="pivot-fold-btn pivot-fold-btn--section" aria-hidden>
          {sectionCollapsed ? "▸" : "▾"}
        </span>
        <span className="pivot-name-text">{sectionTitle}</span>
        <button
          type="button"
          className="pivot-section-settings-btn"
          onClick={(e) => {
            e.stopPropagation();
            onOpenSettings();
          }}
          aria-label={settingsLabel}
          title={settingsLabel}
        >
          ⚙
        </button>
      </td>
      {periods.map((_, idx) => (
        <td key={idx} className="pivot-value-cell" />
      ))}
      {showTotal && <td className="pivot-value-cell pivot-value-cell--total" />}
    </tr>,
  ];
  // Volume metrics (internal transfers) — same row layout as renderRow but
  // skip signClass: these are non-negative volumes, not a financial result,
  // so green tinting on every cell would be visual noise. Mirrors how
  // income/expense rows render plain unsigned numbers.
  const renderVolumeRow = (
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
        <td key={idx} className="pivot-value-cell">
          {formatMoney(formatMinorAsMoney(m))}
        </td>
      ))}
      {showTotal && (
        <td className="pivot-value-cell pivot-value-cell--total">
          {formatMoney(formatMinorAsMoney(total))}
        </td>
      )}
    </tr>
  );

  if (!sectionCollapsed) {
    if (visibleSet.has("net")) {
      out.push(renderRow("metric-net", netLabel, netPerPeriod, netTotal));
    }
    if (visibleSet.has("cumulative")) {
      out.push(
        renderRow(
          "metric-cumulative",
          cumulativeLabel,
          cumulativePerPeriod,
          cumulativeTotal,
        ),
      );
    }
    if (visibleSet.has("opening")) {
      out.push(
        renderRow("metric-opening", openingLabel, openingPerPeriod, openingTotal),
      );
    }
    if (visibleSet.has("closing")) {
      out.push(
        renderRow("metric-closing", closingLabel, closingPerPeriod, closingTotal),
      );
    }
    if (visibleSet.has("internalTransferOut")) {
      out.push(
        renderVolumeRow(
          "metric-internal-transfer-out",
          internalTransferOutLabel,
          transferOutflows,
          transferOutflowsTotal,
        ),
      );
    }
    if (visibleSet.has("internalTransferIn")) {
      out.push(
        renderVolumeRow(
          "metric-internal-transfer-in",
          internalTransferInLabel,
          transferInflows,
          transferInflowsTotal,
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------
// Metrics visibility modal
// ---------------------------------------------------------------

const METRIC_LABEL_KEYS: Record<MetricKey, string> = {
  net: "report.metricNet",
  cumulative: "report.metricNetCumulative",
  opening: "report.metricOpeningBalance",
  closing: "report.metricClosingBalance",
  internalTransferOut: "report.metricInternalTransferOut",
  internalTransferIn: "report.metricInternalTransferIn",
};

interface MetricsSettingsModalProps {
  initial: MetricKey[];
  onCancel: () => void;
  onSave: (next: MetricKey[]) => void;
}

// Modal hosts a checkbox per metric. Edits live locally — only Save commits
// upstream, mirroring the categories picker pattern. ESC + backdrop click
// dismiss without saving.
function MetricsSettingsModal({
  initial,
  onCancel,
  onSave,
}: MetricsSettingsModalProps) {
  const t = useT();
  const [selected, setSelected] = useState<Set<MetricKey>>(new Set(initial));

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  function toggle(key: MetricKey) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal metrics-settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3>{t("report.metricsSettingsTitle")}</h3>
          <button
            type="button"
            className="icon-btn"
            onClick={onCancel}
            aria-label={t("common.close")}
          >
            ×
          </button>
        </header>
        <div className="modal-body metrics-settings-modal-body">
          <ul className="metrics-settings-list">
            {ALL_METRIC_KEYS.map((key) => (
              <li key={key} className="metrics-settings-row">
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    onChange={() => toggle(key)}
                  />
                  <span>{t(METRIC_LABEL_KEYS[key])}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() =>
              onSave(ALL_METRIC_KEYS.filter((k) => selected.has(k)))
            }
          >
            {t("common.save")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
