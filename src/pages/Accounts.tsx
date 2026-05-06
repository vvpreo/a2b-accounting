import {
  Fragment,
  FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useI18n, useT, useTPlural } from "../i18n";
import {
  Account,
  AccountLatestTransaction,
  AccountMonthCell,
  AccountMonthSummary,
  Currency,
  ImportBatch,
  MonthRange,
  ValidationError,
  accountMonthlyStatus,
  accountMonthlySummaryStats,
  createAccount,
  deleteAccount,
  deleteImportBatch,
  firstTransactionDate,
  getSetting,
  latestTransactions,
  listAccounts,
  listCurrencies,
  listImportBatches,
  setSetting,
  updateAccount,
  validateBalanceChain,
} from "../lib/api";
import { ACCOUNT_PRESETS, findPresetByName } from "../lib/account-presets";
import {
  MultiSelectDropdown,
  MultiSelectItem,
} from "../components/MultiSelectDropdown";

const MONTH_DEPTH_OPTIONS = [3, 12, 36, "all"] as const;
type MonthDepth = (typeof MONTH_DEPTH_OPTIONS)[number];
const DEFAULT_MONTH_DEPTH: MonthDepth = 36;
const SETTING_KEY_ACTIVITY_MONTHS = "accounts_activity_months";

// Optional per-month "Сводка" rows — extra strip lines under the activity
// strip that show categorization percentages. Order here is the rendering
// order under each account's strip; adding a metric means appending an id
// (and corresponding i18n keys / formatters in the strip).
const SUMMARY_METRIC_IDS = [
  "income_count",
  "expense_count",
  "income_amount",
  "expense_amount",
] as const;
type SummaryMetricId = (typeof SUMMARY_METRIC_IDS)[number];
const SETTING_KEY_SUMMARY_METRICS = "accounts_summary_metrics";

function parseSummaryMetrics(raw: string | null): SummaryMetricId[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = new Set<string>(SUMMARY_METRIC_IDS);
    const out: SummaryMetricId[] = [];
    for (const id of SUMMARY_METRIC_IDS) {
      if (parsed.includes(id) && valid.has(id)) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

// Translation-key helpers — kept next to the metric ids so renaming an id
// pulls the matching i18n keys with it. See `accounts.summary.*` in the
// locale JSONs.
function summaryFullKey(id: SummaryMetricId): string {
  switch (id) {
    case "income_count":
      return "incomeCountFull";
    case "expense_count":
      return "expenseCountFull";
    case "income_amount":
      return "incomeAmountFull";
    case "expense_amount":
      return "expenseAmountFull";
  }
}

function summaryShortKey(id: SummaryMetricId): string {
  switch (id) {
    case "income_count":
      return "incomeCountLabel";
    case "expense_count":
      return "expenseCountLabel";
    case "income_amount":
      return "incomeAmountLabel";
    case "expense_amount":
      return "expenseAmountLabel";
  }
}

// Vertical layout of a strip row, matching the inline-flex column gap (2px),
// year-row (11px), months-row (18px), and per-summary-row (18px). Used to
// compute the inline height for the strip td so the absolute viewport is
// tall enough to show every row without clipping (and the row resizes when
// the user toggles "Сводка" metrics on or off).
const ROW_GAP_PX = 2;
const YEAR_ROW_PX = 11;
const CELL_ROW_PX = 18;
const SCROLLBAR_GUTTER_PX = 12;

function stripCellHeightPx(metricsCount: number): number {
  // years + gap + months + N × (gap + summary row) + scrollbar gutter.
  return (
    YEAR_ROW_PX +
    ROW_GAP_PX +
    CELL_ROW_PX +
    metricsCount * (ROW_GAP_PX + CELL_ROW_PX) +
    SCROLLBAR_GUTTER_PX
  );
}

function parseDepth(value: string | null): MonthDepth | null {
  if (value === "all") return "all";
  const n = Number.parseInt(value ?? "", 10);
  if (n === 3 || n === 12 || n === 36) return n;
  return null;
}

function depthSelectValue(d: MonthDepth): string {
  return String(d);
}

function monthsBetween(earliestLocalIso: string, now: Date): number {
  // earliestLocalIso is "YYYY-MM-DD" in user-local time. We want the count of
  // full month buckets from that month (inclusive) up to but not including
  // the current month — same convention as the numeric presets.
  const [yStr, mStr] = earliestLocalIso.split("-");
  const earliestYear = Number(yStr);
  const earliestMonth0 = Number(mStr) - 1;
  const diff =
    (now.getFullYear() - earliestYear) * 12 +
    (now.getMonth() - earliestMonth0);
  return Math.max(0, diff);
}

function buildLastNMonthRanges(now: Date, count: number): MonthRange[] {
  // Walk back `count` closed months (previous month and earlier) and then
  // append the current month as a trailing, unanchored bucket. So depth=12
  // produces 13 ranges total: 12 closed + the in-progress current month.
  const baseYear = now.getFullYear();
  const baseMonth = now.getMonth(); // 0-indexed
  const ranges: MonthRange[] = [];
  for (let i = count; i >= 0; i--) {
    const start = new Date(baseYear, baseMonth - i, 1, 0, 0, 0, 0);
    const end = new Date(baseYear, baseMonth - i + 1, 1, 0, 0, 0, 0);
    const yearMonth = `${start.getFullYear()}-${String(
      start.getMonth() + 1,
    ).padStart(2, "0")}`;
    ranges.push({
      yearMonth,
      startUtc: start.toISOString(),
      endUtc: end.toISOString(),
    });
  }
  return ranges;
}
interface AccountFormValues {
  presetId: string;
  currency: string;
  name: string;
  accountNumber: string;
  ownerName: string;
}

const INITIAL_FORM: AccountFormValues = {
  presetId: ACCOUNT_PRESETS[0].id,
  currency: ACCOUNT_PRESETS[0].defaultCurrency,
  name: "",
  accountNumber: "",
  ownerName: "",
};

function formToApi(form: AccountFormValues): {
  name: string;
  bank: string;
  currency: string;
  accountNumber: string;
  ownerName: string;
} {
  const preset = ACCOUNT_PRESETS.find((p) => p.id === form.presetId);
  return {
    name: form.name,
    bank: preset?.name ?? "",
    currency: form.currency,
    accountNumber: form.accountNumber,
    ownerName: form.ownerName,
  };
}

function AccountFields({
  value,
  onChange,
}: {
  value: AccountFormValues;
  onChange: (v: AccountFormValues) => void;
}) {
  const t = useT();
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  useEffect(() => {
    let cancelled = false;
    listCurrencies()
      .then((rows) => {
        if (!cancelled) setCurrencies(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <>
      <label>
        {t("accounts.fieldPreset")}
        <select
          required
          value={value.presetId}
          onChange={(e) => {
            const preset = ACCOUNT_PRESETS.find((p) => p.id === e.target.value);
            onChange({
              ...value,
              presetId: e.target.value,
              currency: preset?.defaultCurrency ?? value.currency,
            });
          }}
        >
          {ACCOUNT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("accounts.fieldCurrency")}
        <select
          required
          value={value.currency}
          onChange={(e) => onChange({ ...value, currency: e.target.value })}
        >
          {value.currency &&
            !currencies.some((c) => c.code === value.currency) && (
              <option value={value.currency}>{value.currency}</option>
            )}
          {currencies.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} — {c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("accounts.fieldName")}
        <input
          required
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          placeholder={t("accounts.fieldNamePlaceholder")}
        />
      </label>
      <label>
        {t("accounts.fieldAccountNumberOptional")}
        <input
          value={value.accountNumber}
          onChange={(e) =>
            onChange({ ...value, accountNumber: e.target.value })
          }
        />
      </label>
      <label>
        {t("accounts.fieldOwnerOptional")}
        <input
          value={value.ownerName}
          onChange={(e) => onChange({ ...value, ownerName: e.target.value })}
        />
      </label>
    </>
  );
}

interface Props {
  onCreateAccount: () => void;
  version: number;
  /// Click handler for individual cells in the activity strip. When provided,
  /// each non-`pre_account` cell becomes a button that asks the host to jump
  /// to the Transactions tab pre-filtered to this account and month.
  onOpenMonth?: (accountId: number, yearMonth: string) => void;
}

export function AccountsPage({ onCreateAccount, version, onOpenMonth }: Props) {
  const t = useT();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detailAccountId, setDetailAccountId] = useState<number | null>(null);
  const [statusCells, setStatusCells] = useState<AccountMonthCell[]>([]);
  const [latestByAccount, setLatestByAccount] = useState<
    Map<number, AccountLatestTransaction>
  >(new Map());
  const [monthsDepth, setMonthsDepth] = useState<MonthDepth>(DEFAULT_MONTH_DEPTH);
  // We don't fetch the strip until the persisted depth has been read once —
  // otherwise we'd issue a wasted request with the default depth and then a
  // second one with the real value.
  const [depthLoaded, setDepthLoaded] = useState(false);
  // null = "all" mode resolution still pending; otherwise the resolved month
  // count from the earliest transaction up to the previous month (0 means
  // there are no transactions at all).
  const [allTimeCount, setAllTimeCount] = useState<number | null>(null);
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  // Which row's help is open in the legend modal — `null` = closed,
  // `"fullness"` = the months strip (pre_account / no_data / complete /
  // anchor / dashed), or the id of a summary metric.
  const [legendTopic, setLegendTopic] = useState<
    SummaryMetricId | "fullness" | null
  >(null);
  const [summaryMetrics, setSummaryMetrics] = useState<SummaryMetricId[]>([]);
  const [summaryRows, setSummaryRows] = useState<AccountMonthSummary[]>([]);

  // All ActivityStrip viewports scroll together. Each strip registers its
  // scroll-viewport DOM node here on mount; the scroll handler mirrors the
  // active scrollLeft to every other registered viewport, and a layout
  // effect parks every viewport at the right edge (current month) whenever
  // the month-range or cell data shifts.
  const stripViewportsRef = useRef<Set<HTMLDivElement>>(new Set());
  const syncingScrollRef = useRef(false);

  const handleStripScroll = useCallback((source: HTMLDivElement) => {
    if (syncingScrollRef.current) return;
    syncingScrollRef.current = true;
    const left = source.scrollLeft;
    for (const el of stripViewportsRef.current) {
      if (el !== source && el.scrollLeft !== left) {
        el.scrollLeft = left;
      }
    }
    requestAnimationFrame(() => {
      syncingScrollRef.current = false;
    });
  }, []);

  const registerStripViewport = useCallback((el: HTMLDivElement) => {
    stripViewportsRef.current.add(el);
  }, []);

  const unregisterStripViewport = useCallback((el: HTMLDivElement) => {
    stripViewportsRef.current.delete(el);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSetting(SETTING_KEY_ACTIVITY_MONTHS)
      .then((value) => {
        if (cancelled) return;
        const parsed = parseDepth(value);
        if (parsed !== null) setMonthsDepth(parsed);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setDepthLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Saved summary-metric selection. Independent from depth — failing to
  // load it just means the strip stays in its default (no extra rows)
  // state, which is fine; we don't gate fetching on this.
  useEffect(() => {
    let cancelled = false;
    getSetting(SETTING_KEY_SUMMARY_METRICS)
      .then((value) => {
        if (cancelled) return;
        setSummaryMetrics(parseSummaryMetrics(value));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve the "all" preset to a concrete month count. Re-runs on `version`
  // so a fresh import or batch deletion shifts the earliest-data anchor.
  useEffect(() => {
    if (monthsDepth !== "all") return;
    let cancelled = false;
    setAllTimeCount(null);
    firstTransactionDate()
      .then((date) => {
        if (cancelled) return;
        if (!date) {
          setAllTimeCount(0);
          return;
        }
        setAllTimeCount(monthsBetween(date, new Date()));
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("[accounts] failed to resolve all-time depth:", e);
        setAllTimeCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [monthsDepth, version]);

  const effectiveCount =
    monthsDepth === "all" ? allTimeCount ?? 0 : monthsDepth;
  const allTimeReady = monthsDepth !== "all" || allTimeCount !== null;

  const monthRanges = useMemo(
    () => buildLastNMonthRanges(new Date(), effectiveCount),
    [effectiveCount],
  );

  function changeDepth(next: MonthDepth) {
    setMonthsDepth(next);
    setSetting(SETTING_KEY_ACTIVITY_MONTHS, String(next)).catch((e) =>
      console.error("[accounts] failed to persist activity depth:", e),
    );
  }

  function changeSummaryMetrics(next: SummaryMetricId[]) {
    // Re-canonicalise to the fixed render order before storing, so a
    // round-trip through localStorage doesn't depend on click order.
    const ordered = SUMMARY_METRIC_IDS.filter((id) => next.includes(id));
    setSummaryMetrics(ordered);
    setSetting(SETTING_KEY_SUMMARY_METRICS, JSON.stringify(ordered)).catch(
      (e) =>
        console.error("[accounts] failed to persist summary metrics:", e),
    );
  }

  const summaryDropdownItems: MultiSelectItem<SummaryMetricId>[] = useMemo(
    () =>
      SUMMARY_METRIC_IDS.map((id) => ({
        id,
        // Short labels (the same ones rendered to the left of each strip
        // row) — keep the dropdown compact; full descriptions live in the
        // info-modal opened from each strip row's (i) button.
        label: t(`accounts.summary.${summaryShortKey(id)}`),
      })),
    [t],
  );

  const refresh = useCallback(async () => {
    if (!depthLoaded || !allTimeReady) return;
    try {
      const [list, latest] = await Promise.all([
        listAccounts(),
        latestTransactions(),
      ]);
      setAccounts(list);
      setLatestByAccount(new Map(latest.map((t) => [t.accountId, t])));
      setError(null);
      if (list.length === 0 || monthRanges.length === 0) {
        setStatusCells([]);
        setSummaryRows([]);
        return;
      }
      // Status drives the activity-strip fill/border; summary stats drive
      // the optional categorisation rows under it. Always fetch both: the
      // user can flip metric checkboxes off and on without a backend round
      // trip, and the data is small (4 ints + 4 short strings per month).
      const [cells, rows] = await Promise.all([
        accountMonthlyStatus(monthRanges),
        accountMonthlySummaryStats(monthRanges),
      ]);
      setStatusCells(cells);
      setSummaryRows(rows);
    } catch (e) {
      setError(String(e));
    }
  }, [depthLoaded, allTimeReady, monthRanges]);

  useEffect(() => {
    refresh();
  }, [version, refresh]);

  const cellsByAccount = useMemo(() => {
    const map = new Map<number, AccountMonthCell[]>();
    for (const c of statusCells) {
      if (!map.has(c.accountId)) map.set(c.accountId, []);
      map.get(c.accountId)!.push(c);
    }
    // Preserve the same chronological order we asked the backend for.
    const order = new Map(monthRanges.map((r, i) => [r.yearMonth, i]));
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          (order.get(a.yearMonth) ?? 0) - (order.get(b.yearMonth) ?? 0),
      );
    }
    return map;
  }, [statusCells, monthRanges]);

  const summaryByAccount = useMemo(() => {
    const map = new Map<number, Map<string, AccountMonthSummary>>();
    for (const r of summaryRows) {
      let perAccount = map.get(r.accountId);
      if (!perAccount) {
        perAccount = new Map();
        map.set(r.accountId, perAccount);
      }
      perAccount.set(r.yearMonth, r);
    }
    return map;
  }, [summaryRows]);

  // Park every strip viewport at the right edge so the current month is
  // in view on first paint after a depth change or a fresh data load.
  useLayoutEffect(() => {
    syncingScrollRef.current = true;
    for (const el of stripViewportsRef.current) {
      el.scrollLeft = el.scrollWidth;
    }
    requestAnimationFrame(() => {
      syncingScrollRef.current = false;
    });
  }, [monthRanges, statusCells]);

  const detailAccount =
    detailAccountId !== null
      ? accounts.find((a) => a.id === detailAccountId) ?? null
      : null;

  return (
    <section className="page page--accounts">
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
          <div className="filter-bar-row">
            <label className="filter-field">
              <span>{t("accounts.menuActivity")}</span>
              <select
                value={depthSelectValue(monthsDepth)}
                onChange={(e) => {
                  const v = e.target.value;
                  changeDepth(
                    v === "all" ? "all" : (Number(v) as 3 | 12 | 36),
                  );
                }}
              >
                {MONTH_DEPTH_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m === "all"
                      ? t("accounts.menuMonthsAll")
                      : t("accounts.menuMonthsValue", { count: m })}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-field">
              <span>{t("accounts.menuSummary")}</span>
              <MultiSelectDropdown<SummaryMetricId>
                items={summaryDropdownItems}
                selected={summaryMetrics}
                onApply={changeSummaryMetrics}
                allLabel={t("accounts.summarySelectAll")}
                noneLabel={t("accounts.summaryNone")}
                emptyItemsLabel={t("accounts.summaryNone")}
                multiSelectedLabel={(count) =>
                  t("accounts.summarySelected", { count })
                }
                applyLabel={t("accounts.summaryApply")}
              />
            </label>
            <button
              type="button"
              className="btn-primary filter-bar-action"
              onClick={onCreateAccount}
            >
              {t("accounts.add")}
            </button>
          </div>
        )}
      </section>

      {error && <div className="error">{error}</div>}

      <div className="accounts-wrap">
        <table className="accounts-table">
          <thead>
          <tr>
            <th>{t("accounts.tableId")}</th>
            <th>{t("accounts.tableName")}</th>
            <th>{t("accounts.tableBank")}</th>
            <th>{t("accounts.tableCurrency")}</th>
            <th>{t("accounts.tableNumber")}</th>
            <th>{t("accounts.tableOwner")}</th>
            <th>{t("accounts.tableLastTxn")}</th>
          </tr>
        </thead>
        <tbody>
          {accounts.length === 0 ? (
            <tr>
              <td colSpan={7} className="empty">
                {t("accounts.empty")}
              </td>
            </tr>
          ) : (
            accounts.map((a) => (
              <Fragment key={a.id}>
                <tr className="account-row">
                  <td>{a.id}</td>
                  <td className="account-name-cell">
                    <span className="account-name-text">{a.name}</span>
                    <button
                      type="button"
                      className="account-edit-btn"
                      onClick={() => setDetailAccountId(a.id)}
                      aria-label={t("accounts.actionDetails")}
                      title={t("accounts.actionDetails")}
                    >
                      ✎
                    </button>
                  </td>
                  <td>{a.bank}</td>
                  <td>{a.currency}</td>
                  <td>{a.accountNumber}</td>
                  <td>{a.ownerName}</td>
                  <td className="last-txn-cell">
                    <LastTransactionCell
                      latest={latestByAccount.get(a.id) ?? null}
                      currency={a.currency}
                    />
                  </td>
                </tr>
                <tr className="account-strip-row">
                  <td className="account-strip-spacer" />
                  <td className="account-strip-spacer account-strip-labels-cell">
                    {latestByAccount.has(a.id) && (
                      <ActivityStripLabels
                        metrics={summaryMetrics}
                        onShowLegend={setLegendTopic}
                      />
                    )}
                  </td>
                  <td
                    colSpan={5}
                    className="account-strip-cell"
                    style={{
                      height: stripCellHeightPx(summaryMetrics.length),
                    }}
                  >
                    <ActivityStrip
                      accountId={a.id}
                      cells={cellsByAccount.get(a.id) ?? []}
                      hasTransactions={latestByAccount.has(a.id)}
                      registerViewport={registerStripViewport}
                      unregisterViewport={unregisterStripViewport}
                      onScroll={handleStripScroll}
                      onOpenMonth={onOpenMonth}
                      summary={summaryByAccount.get(a.id)}
                      metrics={summaryMetrics}
                    />
                  </td>
                </tr>
              </Fragment>
            ))
          )}
        </tbody>
      </table>
      </div>

      {detailAccount && (
        <AccountDetailModal
          account={detailAccount}
          onClose={() => setDetailAccountId(null)}
          onSaved={async () => {
            await refresh();
          }}
          onDeleted={async () => {
            setDetailAccountId(null);
            await refresh();
          }}
        />
      )}

      {legendTopic && (
        <ActivityLegendModal
          topic={legendTopic}
          onClose={() => setLegendTopic(null)}
        />
      )}
    </section>
  );
}

function ActivityLegendModal({
  topic,
  onClose,
}: {
  topic: SummaryMetricId | "fullness";
  onClose: () => void;
}) {
  const t = useT();
  const fillItems: { key: string; cellClass: string; titleKey: string; bodyKey: string }[] = [
    {
      key: "pre_account",
      cellClass: "activity-cell--pre_account",
      titleKey: "accounts.activityStatus.pre_account",
      bodyKey: "accounts.legendItems.preAccount",
    },
    {
      key: "no_data",
      cellClass: "activity-cell--no_data",
      titleKey: "accounts.activityStatus.no_data",
      bodyKey: "accounts.legendItems.noData",
    },
    {
      key: "complete",
      cellClass: "activity-cell--complete",
      titleKey: "accounts.activityStatus.complete",
      bodyKey: "accounts.legendItems.complete",
    },
    {
      key: "error",
      cellClass: "activity-cell--error",
      titleKey: "accounts.legendItems.errorTitle",
      bodyKey: "accounts.legendItems.error",
    },
  ];
  // Border modifiers are shown layered on top of a "complete" fill — the most
  // common base in the wild — so the legend reads like a real cell.
  const borderItems: {
    key: string;
    extraClass: string;
    titleKey: string;
    bodyKey: string;
  }[] = [
    {
      key: "anchored",
      extraClass: "activity-cell--anchored",
      titleKey: "accounts.legendItems.anchoredTitle",
      bodyKey: "accounts.legendItems.anchored",
    },
    {
      key: "dashed",
      extraClass: "activity-cell--anchored activity-cell--dashed",
      titleKey: "accounts.legendItems.dashedTitle",
      bodyKey: "accounts.legendItems.dashed",
    },
  ];

  // The modal scopes itself to the row whose info button was clicked. For
  // the months-strip ("fullness") row that's the existing legend (fill +
  // border modifiers); for any individual summary metric we show only its
  // own description plus a sample heatmap cell.
  const isFullness = topic === "fullness";
  const headerKey = isFullness
    ? "accounts.legendTitle"
    : `accounts.summary.${summaryShortKey(topic as SummaryMetricId)}`;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--legend" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{t(headerKey)}</h3>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="modal-body">
          {isFullness ? (
            <>
              <p className="legend-intro">{t("accounts.legendIntro")}</p>

              <section className="legend-section">
                <h4>{t("accounts.legendFillTitle")}</h4>
                <ul className="legend-list">
                  {fillItems.map((item) => (
                    <li key={item.key}>
                      <span className="legend-cell-frame">
                        <span className={`activity-cell ${item.cellClass}`} />
                      </span>
                      <div className="legend-text">
                        <strong>{t(item.titleKey)}</strong>
                        <span>{t(item.bodyKey)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="legend-section">
                <h4>{t("accounts.legendBorderTitle")}</h4>
                <ul className="legend-list">
                  {borderItems.map((item) => (
                    <li key={item.key}>
                      <span className="legend-cell-frame">
                        <span
                          className={`activity-cell activity-cell--complete ${item.extraClass}`}
                        />
                      </span>
                      <div className="legend-text">
                        <strong>{t(item.titleKey)}</strong>
                        <span>{t(item.bodyKey)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          ) : (
            <section className="legend-section">
              <p className="legend-intro">
                {t(`accounts.summary.${summaryFullKey(topic as SummaryMetricId)}`)}
              </p>
              <ul className="legend-list legend-list--samples">
                {[0, 25, 50, 75, 100].map((pct) => (
                  <li key={pct}>
                    <span className="legend-cell-frame">
                      <span
                        className="activity-cell activity-cell--summary"
                        style={{ background: greenFillForPercent(pct) }}
                      >
                        {pct}%
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

type DetailTab = "general" | "batches";

function AccountDetailModal({
  account,
  onClose,
  onSaved,
  onDeleted,
}: {
  account: Account;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const t = useT();
  const [tab, setTab] = useState<DetailTab>("general");

  const [form, setForm] = useState<AccountFormValues>({
    presetId: findPresetByName(account.bank)?.id ?? ACCOUNT_PRESETS[0].id,
    currency: account.currency,
    name: account.name,
    accountNumber: account.accountNumber,
    ownerName: account.ownerName,
  });
  const [submitting, setSubmitting] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setGeneralError(null);
    setSubmitting(true);
    try {
      await updateAccount({ id: account.id, ...formToApi(form) });
      await onSaved();
      onClose();
    } catch (e) {
      setGeneralError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function onConfirmDelete() {
    setGeneralError(null);
    setDeleting(true);
    try {
      await deleteAccount(account.id);
      await onDeleted();
    } catch (e) {
      setGeneralError(String(e));
      setDeleting(false);
    }
  }

  const busy = submitting || deleting;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>
            {account.name} — {account.bank}
            {account.accountNumber ? ` · ${account.accountNumber}` : ""} (
            {account.currency})
          </h3>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="modal-tabs">
          <button
            type="button"
            className={`modal-tab-button${tab === "general" ? " active" : ""}`}
            onClick={() => setTab("general")}
          >
            {t("accounts.detailsTabGeneral")}
          </button>
          <button
            type="button"
            className={`modal-tab-button${tab === "batches" ? " active" : ""}`}
            onClick={() => setTab("batches")}
          >
            {t("accounts.detailsTabBatches")}
          </button>
        </div>
        {tab === "general" ? (
          <form onSubmit={onSubmit}>
            <div className="modal-body">
              <div className="account-form account-form--modal">
                <AccountFields value={form} onChange={setForm} />
              </div>
              {confirmingDelete && (
                <div className="delete-confirm">
                  {t("accounts.deleteConfirm", {
                    name: account.name || account.accountNumber,
                  })}
                  <div className="delete-confirm-actions">
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={deleting}
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={onConfirmDelete}
                      disabled={deleting}
                    >
                      {deleting
                        ? t("common.deleting")
                        : t("accounts.deleteConfirmYes")}
                    </button>
                  </div>
                </div>
              )}
              {generalError && <div className="error">{generalError}</div>}
            </div>
            <footer className="modal-footer">
              <button
                type="button"
                className="btn-danger-ghost modal-footer-left"
                onClick={() => setConfirmingDelete(true)}
                disabled={busy || confirmingDelete}
              >
                {t("accounts.deleteButton")}
              </button>
              <button type="button" className="btn-ghost" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="btn-primary" disabled={busy}>
                {submitting ? t("common.saving") : t("common.save")}
              </button>
            </footer>
          </form>
        ) : (
          <BatchesTab account={account} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function BatchesTab({ account }: { account: Account }) {
  const t = useT();
  const tPlural = useTPlural();
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [confirmingBatchId, setConfirmingBatchId] = useState<number | null>(
    null,
  );
  const [deletingBatchId, setDeletingBatchId] = useState<number | null>(null);

  async function refresh() {
    try {
      const [b, v] = await Promise.all([
        listImportBatches(account.id),
        validateBalanceChain(account.id),
      ]);
      setBatches(b);
      setValidationErrors(v);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, [account.id]);

  async function onConfirmDeleteBatch(batchId: number) {
    setDeletingBatchId(batchId);
    try {
      await deleteImportBatch(batchId);
      setConfirmingBatchId(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeletingBatchId(null);
    }
  }

  return (
    <div className="modal-body">
      {error && <div className="error">{error}</div>}

      {validationErrors.length === 0 ? (
        <div className="ok">{t("accounts.detailsBalanceChainOk")}</div>
      ) : (
        <div className="validation-warning">
          {tPlural(
            "accounts.detailsBalanceChainBroken",
            validationErrors.length,
          )}
        </div>
      )}

      <aside className="batches-panel batches-panel--full">
        <h3>{t("accounts.detailsBatchesTitle")}</h3>
        {batches.length === 0 ? (
          <p className="empty">{t("accounts.detailsBatchesEmpty")}</p>
        ) : (
          <ul>
            {batches.map((b) => {
              const confirming = confirmingBatchId === b.id;
              const deleting = deletingBatchId === b.id;
              return (
                <li key={b.id}>
                  <div className="batch-time">
                    {formatInstant(b.importedAt)}
                  </div>
                  <div className="batch-filename">
                    {b.sourceFilename ?? "—"}
                  </div>
                  <div className="batch-meta">
                    {tPlural("accounts.detailsBatchRows", b.rowCount)} ·{" "}
                    {t("accounts.detailsBatchTimezone")}{" "}
                    {b.timezoneOffset || "—"}
                  </div>
                  {!confirming ? (
                    <button
                      type="button"
                      className="btn-danger-ghost"
                      onClick={() => setConfirmingBatchId(b.id)}
                    >
                      {t("common.delete")}
                    </button>
                  ) : (
                    <div className="delete-confirm">
                      {t("accounts.detailsBatchDeleteConfirm")}
                      <div className="delete-confirm-actions">
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => setConfirmingBatchId(null)}
                          disabled={deleting}
                        >
                          {t("common.cancel")}
                        </button>
                        <button
                          type="button"
                          className="btn-danger"
                          onClick={() => onConfirmDeleteBatch(b.id)}
                          disabled={deleting}
                        >
                          {deleting
                            ? t("common.deleting")
                            : t("accounts.detailsBatchDeleteYes")}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </div>
  );
}

export function CreateAccountModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState<AccountFormValues>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createAccount(formToApi(form));
      onCreated();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{t("accounts.create")}</h3>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
            type="button"
          >
            ×
          </button>
        </header>
        <form onSubmit={onSubmit}>
          <div className="modal-body">
            <div className="account-form account-form--modal">
              <AccountFields value={form} onChange={setForm} />
            </div>
            {error && <div className="error">{error}</div>}
          </div>
          <footer className="modal-footer">
            <button type="button" className="btn-ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? t("common.saving") : t("accounts.create")}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function LastTransactionCell({
  latest,
  currency,
}: {
  latest: AccountLatestTransaction | null;
  currency: string;
}) {
  const { locale } = useI18n();
  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }),
    [locale],
  );
  const amountFmt = useMemo(() => {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        signDisplay: "exceptZero",
      });
    } catch {
      // Unknown / non-ISO currency code (e.g. crypto) — fall back to plain
      // number formatting and append the currency string manually.
      return null;
    }
  }, [locale, currency]);

  if (!latest) return <span className="muted">—</span>;

  const date = dateFmt.format(new Date(latest.occurredAtUtc));
  const n = Number(latest.amountMinor);
  const amount = Number.isFinite(n)
    ? amountFmt
      ? amountFmt.format(n)
      : `${n > 0 ? "+" : ""}${latest.amountMinor} ${currency}`
    : `${latest.amountMinor} ${currency}`;

  return (
    <span className="last-txn">
      <span className="last-txn-date">{date}</span>
      <span className="last-txn-amount">{amount}</span>
    </span>
  );
}

/// Right-aligned labels column rendered next to the activity strip. Lives
/// in the table's left-of-strip spacer cell so it never eats horizontal
/// space inside the strip's scroll viewport. Heights / gaps mirror the
/// strip's stack (years 11px → months 18px → summary rows 18px each, gap
/// 2px) so each label sits exactly opposite the row it describes.
function ActivityStripLabels({
  metrics,
  onShowLegend,
}: {
  metrics: SummaryMetricId[];
  onShowLegend: (topic: SummaryMetricId | "fullness") => void;
}) {
  const t = useT();
  return (
    <div className="account-strip-labels-stack">
      <div
        className="account-strip-labels-spacer activity-strip-row-label--years-spacer"
        aria-hidden="true"
      />
      <LabelRow
        text={t("accounts.summary.fullnessLabel")}
        title={t("accounts.summary.fullnessFull")}
        emphasis
        onShowLegend={() => onShowLegend("fullness")}
        infoLabel={t("accounts.summary.infoButtonLabel")}
      />
      {metrics.map((m) => (
        <LabelRow
          key={m}
          text={t(`accounts.summary.${summaryShortKey(m)}`)}
          title={t(`accounts.summary.${summaryFullKey(m)}`)}
          onShowLegend={() => onShowLegend(m)}
          infoLabel={t("accounts.summary.infoButtonLabel")}
        />
      ))}
    </div>
  );
}

function LabelRow({
  text,
  title,
  emphasis,
  onShowLegend,
  infoLabel,
}: {
  text: string;
  title: string;
  emphasis?: boolean;
  onShowLegend: () => void;
  infoLabel: string;
}) {
  return (
    <div
      className={[
        "activity-strip-row-label",
        emphasis ? "activity-strip-row-label--main" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={title}
    >
      <span className="activity-strip-row-label-text">{text}</span>
      <button
        type="button"
        className="activity-strip-row-info"
        onClick={onShowLegend}
        aria-label={infoLabel}
        title={infoLabel}
      >
        i
      </button>
    </div>
  );
}

function ActivityStrip({
  accountId,
  cells,
  hasTransactions,
  registerViewport,
  unregisterViewport,
  onScroll,
  onOpenMonth,
  summary,
  metrics,
}: {
  accountId: number;
  cells: AccountMonthCell[];
  hasTransactions: boolean;
  registerViewport: (el: HTMLDivElement) => void;
  unregisterViewport: (el: HTMLDivElement) => void;
  onScroll: (source: HTMLDivElement) => void;
  onOpenMonth?: (accountId: number, yearMonth: string) => void;
  /// Per-month rollup keyed by `yearMonth`. Missing keys = empty month
  /// (treated as no data for the corresponding metric).
  summary?: Map<string, AccountMonthSummary>;
  /// Subset of `SUMMARY_METRIC_IDS` to render — order is fixed to match
  /// `SUMMARY_METRIC_IDS`, the host re-canonicalises before passing here.
  metrics: SummaryMetricId[];
}) {
  const t = useT();
  const { locale } = useI18n();
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Accounts with zero transactions skip the strip and the scroll sync;
    // there is nothing to align with the other strips.
    if (!hasTransactions) return;
    const el = viewportRef.current;
    if (!el) return;
    registerViewport(el);
    return () => unregisterViewport(el);
  }, [hasTransactions, registerViewport, unregisterViewport]);

  const monthFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }),
    [locale],
  );
  // Use the long form and slice 3 alphabetic chars: this is locale-correct
  // for both ru ("январь" → "Янв") and en ("January" → "Jan"). The "short"
  // format is unreliable here — Russian "short" uses genitive case and
  // sometimes adds a trailing dot.
  const longMonthFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "long" }),
    [locale],
  );

  function tooltip(c: AccountMonthCell): string {
    const [yearStr, monthStr] = c.yearMonth.split("-");
    const monthLabel = monthFormatter.format(
      new Date(Number(yearStr), Number(monthStr) - 1, 1),
    );
    const lines = [
      `${monthLabel} — ${t(`accounts.activityStatus.${c.status}`)}`,
    ];
    if (c.balanceError) lines.push(t("accounts.activityBalanceError"));
    if (c.uncategorizedCorrecting)
      lines.push(t("accounts.activityUncategorizedCorrecting"));
    return lines.join("\n");
  }

  function shortLabel(c: AccountMonthCell): string {
    const [yearStr, monthStr] = c.yearMonth.split("-");
    const raw = longMonthFormatter.format(
      new Date(Number(yearStr), Number(monthStr) - 1, 1),
    );
    // Pull only the leading word (some locales prepend numbers/punctuation).
    const word = raw.match(/^[\p{L}]+/u)?.[0] ?? raw;
    const slice = word.slice(0, 3);
    return slice.charAt(0).toUpperCase() + slice.slice(1).toLowerCase();
  }

  // Group consecutive cells by calendar year so we can render a year label
  // sized to span exactly the months belonging to that year. The widths are
  // chosen so each label's left edge sits on top of the leftmost month
  // square of its year run.
  const yearRuns = useMemo(() => {
    const runs: { year: string; count: number }[] = [];
    for (const c of cells) {
      const y = c.yearMonth.slice(0, 4);
      const last = runs[runs.length - 1];
      if (last && last.year === y) last.count += 1;
      else runs.push({ year: y, count: 1 });
    }
    return runs;
  }, [cells]);

  // Run width in the months row: count * 39px (cells) + (count - 1) * 2px
  // (inter-cell flex gap) = 41 * count - 2.
  function runWidthPx(count: number): number {
    return 41 * count - 2;
  }

  if (!hasTransactions) {
    return (
      <div className="activity-strip-empty">
        {t("accounts.activityNoTransactions")}
      </div>
    );
  }

  return (
    <div
      className="activity-scroll-viewport"
      ref={viewportRef}
      onScroll={(e) => onScroll(e.currentTarget)}
    >
      <div className="activity-strip-stack">
        <div className="activity-strip-years" aria-hidden="true">
          {yearRuns.map((run, idx) => (
            <Fragment key={`${run.year}-${idx}`}>
              {idx > 0 && (
                <span className="activity-strip-year-gap" aria-hidden="true" />
              )}
              <span
                className="activity-strip-year-label"
                style={{ width: `${runWidthPx(run.count)}px` }}
              >
                {run.year}
              </span>
            </Fragment>
          ))}
        </div>
        <div className="activity-strip">
          {cells.map((c, i) => {
            const prev = i > 0 ? cells[i - 1] : null;
            const yearChanged =
              prev !== null &&
              c.yearMonth.slice(0, 4) !== prev.yearMonth.slice(0, 4);
            const isPreAccount = c.status === "pre_account";
            return (
              <Fragment key={c.yearMonth}>
                {yearChanged && (
                  <span
                    className="activity-strip-year-gap"
                    aria-hidden="true"
                  />
                )}
                {(() => {
                  const className = [
                    "activity-cell",
                    `activity-cell--${c.status}`,
                    // Anchor border (black) — only meaningful on a non-pre cell.
                    c.anchored && !isPreAccount
                      ? "activity-cell--anchored"
                      : "",
                    c.balanceError ? "activity-cell--error" : "",
                    c.uncategorizedCorrecting ? "activity-cell--dashed" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  if (isPreAccount) {
                    return (
                      <span
                        className={className}
                        aria-hidden="true"
                      />
                    );
                  }
                  // Real cells become buttons so a click jumps the user to
                  // Transactions filtered to this account + month.
                  return (
                    <button
                      type="button"
                      className={className}
                      title={tooltip(c)}
                      onClick={() => onOpenMonth?.(accountId, c.yearMonth)}
                    >
                      {shortLabel(c)}
                    </button>
                  );
                })()}
              </Fragment>
            );
          })}
        </div>
        {metrics.map((m) => (
          <SummaryStrip
            key={m}
            metric={m}
            cells={cells}
            summary={summary}
            monthFormatter={monthFormatter}
          />
        ))}
      </div>
    </div>
  );
}

function summaryMetricValues(
  metric: SummaryMetricId,
  s: AccountMonthSummary | undefined,
): { num: number; den: number } {
  if (!s) return { num: 0, den: 0 };
  switch (metric) {
    case "income_count":
      return { num: s.incomeCategorizedCount, den: s.incomeTotalCount };
    case "expense_count":
      return { num: s.expenseCategorizedCount, den: s.expenseTotalCount };
    case "income_amount":
      return {
        num: Number(s.incomeCategorizedShareMinor),
        den: Number(s.incomeTotalMinor),
      };
    case "expense_amount":
      return {
        num: Number(s.expenseCategorizedShareMinor),
        den: Number(s.expenseTotalMinor),
      };
  }
}

function formatCountValue(n: number): string {
  // Both backend buckets are i64 transaction counts — already integral.
  return Number.isFinite(n) ? String(Math.round(n)) : "—";
}

function formatAmountValue(n: number): string {
  // Decimal-string sums coming back from Rust round-trip cleanly into
  // JS numbers as long as they fit in 2^53. Show one decimal where it
  // makes a visible difference, otherwise integer.
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  if (Math.abs(n) >= 100) return n.toFixed(0);
  return n.toFixed(1);
}

function SummaryStrip({
  metric,
  cells,
  summary,
  monthFormatter,
}: {
  metric: SummaryMetricId;
  cells: AccountMonthCell[];
  summary: Map<string, AccountMonthSummary> | undefined;
  monthFormatter: Intl.DateTimeFormat;
}) {
  const t = useT();
  const fullKey = summaryFullKey(metric);

  return (
    <div
      className={`activity-strip activity-strip--summary activity-strip--summary-${metric}`}
    >
      {cells.map((c, i) => {
        const prev = i > 0 ? cells[i - 1] : null;
        const yearChanged =
          prev !== null &&
          c.yearMonth.slice(0, 4) !== prev.yearMonth.slice(0, 4);
        const isPreAccount = c.status === "pre_account";
        const monthSummary = summary?.get(c.yearMonth);
        const { num, den } = summaryMetricValues(metric, monthSummary);
        const empty = den <= 0;
        const pct = empty ? null : Math.round((num / den) * 100);

        const [yearStr, monthStr] = c.yearMonth.split("-");
        const monthLabel = monthFormatter.format(
          new Date(Number(yearStr), Number(monthStr) - 1, 1),
        );
        const isCount = metric === "income_count" || metric === "expense_count";
        const tooltip = isPreAccount
          ? undefined
          : empty
            ? `${monthLabel} — ${t(`accounts.summary.${fullKey}`)}\n${t(
                "accounts.summary.tooltipNoData",
              )}`
            : `${monthLabel} — ${t(`accounts.summary.${fullKey}`)}\n${pct}% (${
                isCount ? formatCountValue(num) : formatAmountValue(num)
              } / ${isCount ? formatCountValue(den) : formatAmountValue(den)})`;

        // Tints the cell background from light grey (0%) to a saturated
        // green (100%) — gives a heat-map feel so the user can scan a row
        // without reading every percent. Only applies to cells with real
        // data (denominator > 0).
        const fillStyle =
          empty || isPreAccount || pct === null
            ? undefined
            : { background: greenFillForPercent(pct) };

        return (
          <Fragment key={c.yearMonth}>
            {yearChanged && (
              <span className="activity-strip-year-gap" aria-hidden="true" />
            )}
            <span
              className={[
                "activity-cell",
                "activity-cell--summary",
                isPreAccount ? "activity-cell--summary-pre" : "",
                empty && !isPreAccount
                  ? "activity-cell--summary--empty"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={tooltip}
              aria-hidden={isPreAccount ? "true" : undefined}
              style={fillStyle}
            >
              {isPreAccount || empty ? "" : `${pct}%`}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

/// Linear interpolation between a near-white tint at 0 % and a soft pastel
/// green at 100 %. Deliberately lighter than `.activity-cell--complete`
/// (#22c55e, the months row's "data present" colour) so the summary
/// heatmap doesn't visually merge with the strip above it.
function greenFillForPercent(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const ratio = clamped / 100;
  // 0 % → near-white #f4f4f5, 100 % → Tailwind green-300 #86efac.
  const r = Math.round(244 - (244 - 134) * ratio);
  const g = Math.round(244 - (244 - 239) * ratio);
  const b = Math.round(245 - (245 - 172) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}
