import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { MultiSelectDropdown } from "../../components/MultiSelectDropdown";
import { SelectDropdown } from "../../components/SelectDropdown";
import { useI18n, useT } from "../../i18n";
import {
  Account,
  Category,
  computeWaterfall,
  firstTransactionDate,
  listAccounts,
  listCategories,
  ReportRange,
  ReportRequest,
  ReportView,
  updateReportView,
  WaterfallConfig,
  WaterfallFixedRate,
  WaterfallOrientation,
  WaterfallRateMode,
  WaterfallResponse,
} from "../../lib/api";
import { listen } from "../../lib/events";
import { formatMinorAsMoney, formatMoney, parseMoneyToMinor } from "../../lib/money";
import {
  addStep,
  allocateToSteps,
  buildWaterfallColumns,
  canMoveStep,
  carvedOutSteps,
  coveredByStep,
  drillCategory,
  drillOwn,
  drillRest,
  drillUncategorized,
  orderedSteps,
  moveStep,
  normalizeRate,
  validFixedRates,
  toggleStep,
  WaterfallColumn,
  WaterfallDrill,
  waterfallScale,
  waterfallZones,
} from "../../lib/report-waterfall";
import { useViewState } from "../../lib/view-state";
import { copyOrDownloadPng, renderWaterfallImage } from "../../lib/waterfall-image";
import { buildWaterfallSheet, downloadWaterfallXlsx } from "../../lib/waterfall-xlsx";
import type { CellClickInfo } from "../ReportView";
import { PeriodDropdown, periodPresets } from "../transactions/PeriodDropdown";
import { CellTransactionsModal } from "./CellTransactionsModal";
import { reportPeriodBounds, reportRangeFromPeriod, resolveRange } from "./report-period";

interface Props {
  view: ReportView;
  onSaved: (view: ReportView) => void;
}

const AUTOSAVE_DELAY_MS = 500;
// Narrower than this and a column's value no longer fits: the chart scrolls instead.
const MIN_COLUMN_WIDTH = 84;
const MIN_ROW_HEIGHT = 36;
const SHEET_SECTIONS: Record<WaterfallColumn["kind"], string> = {
  opening: "balance",
  closing: "balance",
  income: "income",
  incomeStep: "income",
  otherIncome: "income",
  expense: "expense",
  other: "expense",
  system: "system",
};

function parseConfig(raw: string): WaterfallConfig {
  const fallback: WaterfallConfig = {
    version: 1,
    kind: "waterfall",
    accountIds: [],
    defaultRange: { kind: "preset", preset: "months_12" },
    steps: [],
  };
  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<WaterfallConfig>) };
  } catch {
    return fallback;
  }
}

const money = (minorAmount: number) => formatMoney(formatMinorAsMoney(minorAmount));
const signedMoney = (minorAmount: number) => (minorAmount > 0 ? "+" : "") + money(minorAmount);
/** Whole units: what fits above a column. Cents are in the tooltip and the details. */
const wholeMoney = (minorAmount: number) => formatMoney(String(Math.round(minorAmount / 100)));
const shortDate = (iso: string) => iso.split("-").reverse().join(".");
const isTotal = (column: WaterfallColumn) => column.kind === "opening" || column.kind === "closing";
const isIncome = (column: WaterfallColumn) =>
  column.kind === "income" || column.kind === "incomeStep" || column.kind === "otherIncome";
const isExpense = (column: WaterfallColumn) => column.kind === "expense" || column.kind === "other";

function categoryPath(id: number, byId: Map<number, Category>): string {
  const names: string[] = [];
  const seen = new Set<number>();
  let node = byId.get(id);
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    names.unshift(node.name);
    node = node.parentId === null ? undefined : byId.get(node.parentId);
  }
  return names.join(" / ");
}

function useColumnLabel(byId: Map<number, Category>) {
  const t = useT();
  return (column: WaterfallColumn): string => {
    if (column.categoryId !== null) return byId.get(column.categoryId)?.name ?? "";
    return t(`waterfall.${column.kind}`);
  };
}

/// The waterfall report: one chart for the whole period. The opening balance,
/// what came in, the expense categories in the user's order, the other expenses
/// and the closing balance. There is no breakdown by time here: the columns are
/// categories.
export function WaterfallPage({ view, onSaved }: Props) {
  const t = useT();
  const initial = useMemo(() => parseConfig(view.config), [view.config]);

  const [accountIds, setAccountIds] = useState<number[]>(initial.accountIds);
  const [range, setRange] = useState<ReportRange>(initial.defaultRange);
  const [currency, setCurrency] = useState<string | null>(initial.currency ?? null);
  const [steps, setSteps] = useState<number[]>(initial.steps);
  const [orientation, setOrientation] = useState<WaterfallOrientation>(initial.orientation ?? "vertical");
  const [rateMode, setRateMode] = useState<WaterfallRateMode>(initial.rateMode ?? "system");
  const [fixedRates, setFixedRates] = useState<Record<string, Record<string, WaterfallFixedRate>>>(
    initial.fixedRates ?? {},
  );
  const [filtersExpanded, setFiltersExpanded] = useViewState(`report.${view.id}.filtersExpanded`, true);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [earliestTxnDate, setEarliestTxnDate] = useState<string | null>(null);
  const [data, setData] = useState<WaterfallResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [detail, setDetail] = useState<WaterfallColumn | null>(null);
  const [drill, setDrill] = useState<{ drill: WaterfallDrill; label: string; amount: number } | null>(null);

  // Rates download in the background: fresh ones change the numbers on screen.
  useEffect(() => {
    const unlisten = listen("rates:download:completed", () => setReloadVersion((v) => v + 1));
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    listAccounts().then(setAccounts).catch((e) => setError(String(e)));
    listCategories().then(setCategories).catch((e) => setError(String(e)));
  }, []);

  const currencies = useMemo(() => [...new Set(accounts.map((a) => a.currency))], [accounts]);
  useEffect(() => {
    if (currencies.length > 0 && (currency === null || !currencies.includes(currency))) {
      setCurrency(currencies[0]);
    }
  }, [currencies, currency]);

  useEffect(() => {
    let cancelled = false;
    firstTransactionDate(accountIds.length > 0 ? accountIds : undefined)
      .then((d) => {
        if (!cancelled) setEarliestTxnDate(d);
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [accountIds]);

  const resolved = useMemo(() => resolveRange(range, earliestTxnDate), [range, earliestTxnDate]);
  const from = resolved?.from ?? "";
  const to = resolved?.to ?? "";

  // The currencies this report has to convert, in account order.
  const foreignCurrencies = useMemo(
    () => [
      ...new Set(
        accounts.filter((a) => accountIds.includes(a.id) && a.currency !== currency).map((a) => a.currency),
      ),
    ],
    [accounts, accountIds, currency],
  );
  const ownRates = currency ? fixedRates[currency] : undefined;
  // A string, so that retyping the same rate doesn't ask the server again.
  const sentRates = JSON.stringify(
    rateMode === "fixed" ? validFixedRates(ownRates, foreignCurrencies) : null,
  );

  useEffect(() => {
    if (!from || !to || !currency) return;
    let cancelled = false;
    const parsed = JSON.parse(sentRates) as WaterfallFixedRate[] | null;
    computeWaterfall({ accountIds, from, to, currency, fixedRates: parsed ?? undefined })
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [accountIds, from, to, currency, sentRates, reloadVersion]);

  // Auto-save like the Cash Flow report; a change still waiting on the timer is
  // written on the way out, so leaving the tab right after a click loses nothing.
  const payload = JSON.stringify({
    ...initial,
    accountIds,
    defaultRange: range,
    currency: currency ?? undefined,
    steps,
    // Left out while it is the default, so opening the report doesn't rewrite it.
    orientation: orientation === "vertical" ? undefined : orientation,
    rateMode: rateMode === "system" ? undefined : rateMode,
    fixedRates: Object.keys(fixedRates).length > 0 ? fixedRates : undefined,
  });
  const lastSaved = useRef(JSON.stringify(initial));
  const pendingSave = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (payload === lastSaved.current) return;
    const save = () => {
      pendingSave.current = null;
      lastSaved.current = payload;
      updateReportView({ id: view.id, name: view.name, config: payload })
        .then(onSaved)
        .catch((e) => setError(String(e)));
    };
    pendingSave.current = save;
    const timer = window.setTimeout(save, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [payload, view.id, view.name, onSaved]);
  useEffect(() => () => pendingSave.current?.(), []);

  const presets = periodPresets();
  const periodBounds = reportPeriodBounds(range, presets, earliestTxnDate);
  function onPeriodChange(nextFrom: string, nextTo: string) {
    const next = reportRangeFromPeriod(nextFrom, nextTo, presets);
    if (next) setRange(next);
  }

  const known = useMemo(() => orderedSteps(steps, categories), [steps, categories]);
  const columns = useMemo(
    () => (data ? buildWaterfallColumns(data, categories, steps) : []),
    [data, categories, steps],
  );
  const accountNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of accounts) {
      m.set(a.id, `${a.name || a.accountNumber || `#${a.id}`} · ${a.currency}`);
    }
    return m;
  }, [accounts]);
  const periodLabel = from && to ? `${shortDate(from)} – ${shortDate(to)}` : "";
  // How this report converts, in words: exports must say which rates they used.
  const rateLabel = (() => {
    if (rateMode !== "fixed") return t("waterfall.rateModeSystem");
    const sent = JSON.parse(sentRates) as WaterfallFixedRate[];
    const used = foreignCurrencies.flatMap((c) => {
      const rate = sent.find((r) => r.currency === c) ?? data?.suggestedRates.find((r) => r.currency === c);
      if (!rate) return [];
      return rate.perReport ? `1 ${currency} = ${rate.rate} ${c}` : `1 ${c} = ${rate.rate} ${currency}`;
    });
    return [t("waterfall.rateModeFixed"), ...used].join("; ");
  })();

  // A category column with nothing inside goes straight to its transactions;
  // everything else first shows what it consists of.
  function openColumn(column: WaterfallColumn) {
    const id = column.categoryId;
    if (id !== null && !categories.some((c) => c.parentId === id)) {
      setDrill({
        drill: drillCategory(id, categories, known),
        label: categories.find((c) => c.id === id)?.name ?? "",
        amount: Math.abs(column.deltaMinor),
      });
    } else {
      setDetail(column);
    }
  }

  const drillRequest: ReportRequest | null =
    drill && data
      ? {
          accountIds: data.accounts.map((a) => a.accountId),
          expenseCategoryIds: drill.drill.expenseCategoryIds,
          incomeCategoryIds: drill.drill.incomeCategoryIds,
          from,
          to,
          granularity: "month",
        }
      : null;
  const drillInfo: CellClickInfo | null = drill
    ? {
        target: drill.drill.target,
        categoryLabel: drill.label,
        periodLabel,
        sectionKind: drill.drill.target.section,
        amount: formatMinorAsMoney(drill.amount),
      }
    : null;

  return (
    <section className="page report-page waterfall-page">
      <section className={`filter-bar${filtersExpanded ? "" : " filter-bar--collapsed"}`}>
        <button
          type="button"
          className="filter-bar-handle"
          onClick={() => setFiltersExpanded((v) => !v)}
          aria-label={filtersExpanded ? t("toolbar.collapse") : t("toolbar.expand")}
          title={filtersExpanded ? t("toolbar.collapse") : t("toolbar.expand")}
        >
          <span className="filter-bar-handle-grip" />
        </button>
        {filtersExpanded && (
          <div className="filter-bar-row report-filter-bar-row">
            <div className="filter-field">
              <span>{t("builder.accountsLabel")}</span>
              <MultiSelectDropdown<number>
                items={accounts.map((a) => ({ id: a.id, label: accountNameById.get(a.id) ?? "" }))}
                selected={accountIds}
                onApply={setAccountIds}
                allLabel={t("builder.accountsAll")}
                noneLabel={t("builder.accountsNone")}
                emptyItemsLabel={t("builder.accountsEmpty")}
                multiSelectedLabel={(count) => t("builder.accountsMany", { count })}
                applyLabel={t("builder.accountsApply")}
              />
            </div>
            <div className="filter-field">
              <span>{t("report.rangeLabel")}</span>
              <PeriodDropdown
                from={periodBounds.from}
                to={periodBounds.to}
                presets={presets}
                onChange={onPeriodChange}
              />
            </div>
            <div className="filter-field">
              <span>{t("waterfall.currencyLabel")}</span>
              <SelectDropdown
                value={currency ?? ""}
                options={currencies.map((c) => ({ value: c, label: c }))}
                onChange={setCurrency}
              />
            </div>
            <div className="filter-field">
              <span>{t("waterfall.orientationLabel")}</span>
              <SelectDropdown
                value={orientation}
                options={[
                  { value: "vertical", label: t("waterfall.orientationVertical") },
                  { value: "horizontal", label: t("waterfall.orientationHorizontal") },
                ]}
                onChange={(value) => setOrientation(value as WaterfallOrientation)}
              />
            </div>
            <div className="filter-field">
              <span>{t("waterfall.rateModeLabel")}</span>
              <SelectDropdown
                value={rateMode}
                options={[
                  { value: "system", label: t("waterfall.rateModeSystem") },
                  { value: "fixed", label: t("waterfall.rateModeFixed") },
                ]}
                onChange={(value) => setRateMode(value as WaterfallRateMode)}
              />
            </div>
          </div>
        )}
      </section>

      {rateMode === "fixed" && currency && foreignCurrencies.length > 0 && (
        <FixedRates
          currencies={foreignCurrencies}
          reportCurrency={currency}
          rates={ownRates ?? {}}
          suggested={data?.suggestedRates ?? []}
          onChange={(next) => setFixedRates((all) => ({ ...all, [currency]: next }))}
        />
      )}
      {error && <div className="waterfall-notice waterfall-notice--error">{error}</div>}
      {data && data.missingRates.length > 0 && (
        <div className="waterfall-notice">
          ⚠ {t("waterfall.accountsHidden", { currencies: data.missingRates.join(", ") })}
        </div>
      )}
      {data && data.staleRates.length > 0 && (
        <div className="waterfall-notice">
          ⚠{" "}
          {t("waterfall.ratesStale", {
            rates: data.staleRates.map((r) => `${r.currency} — ${shortDate(r.latestDate)}`).join(", "),
          })}
        </div>
      )}

      <div className="waterfall-body">
        <div className="waterfall-chart-wrap">
          {data && (
            <div className="waterfall-chart-head">
              <BalanceChange data={data} />
              <ChartActions
                columns={columns}
                currency={data.currency}
                categories={categories}
                steps={known}
                orientation={orientation}
                from={from}
                to={to}
                periodLabel={periodLabel}
                change={balanceChangeText(data)}
                rateLabel={rateLabel}
                onError={setError}
              />
            </div>
          )}
          {data && (
            <WaterfallChart
              columns={columns}
              currency={data.currency}
              categories={categories}
              steps={known}
              orientation={orientation}
              from={from}
              to={to}
              onOpen={openColumn}
            />
          )}
        </div>
        {data && (
          <StepsPanel
            data={data}
            categories={categories}
            steps={known}
            viewId={view.id}
            onToggle={(id) => setSteps(toggleStep(known, id, categories))}
            onMove={(id, dir) => setSteps(moveStep(known, id, dir, categories))}
          />
        )}
      </div>

      {detail && data && (
        <ColumnDetailModal
          column={detail}
          data={data}
          categories={categories}
          steps={known}
          rateMode={rateMode}
          periodLabel={periodLabel}
          accountNameById={accountNameById}
          viewId={view.id}
          onClose={() => setDetail(null)}
          onDrill={(next, label, amount) => setDrill({ drill: next, label, amount })}
          onAddStep={(id) => setSteps(addStep(known, id, categories))}
        />
      )}
      {drillRequest && drillInfo && (
        <CellTransactionsModal
          request={drillRequest}
          info={drillInfo}
          accountNameById={accountNameById}
          onClose={() => setDrill(null)}
          onChanged={() => setReloadVersion((v) => v + 1)}
        />
      )}
    </section>
  );
}

interface FixedRatesProps {
  currencies: string[];
  reportCurrency: string;
  rates: Record<string, WaterfallFixedRate>;
  suggested: WaterfallFixedRate[];
  onChange: (rates: Record<string, WaterfallFixedRate>) => void;
}

/// One rate per currency for the whole period. Each starts as the suggested one;
/// only what the user changes is kept, so the rest follows the chosen period.
function FixedRates({ currencies, reportCurrency, rates, suggested, onChange }: FixedRatesProps) {
  const t = useT();
  return (
    <div className="waterfall-rates">
      <span className="waterfall-rates-hint">{t("waterfall.ratesHint")}</span>
      {currencies.map((currency) => {
        const offered = suggested.find((r) => r.currency === currency);
        const own = rates[currency];
        const perReport = own?.perReport ?? offered?.perReport ?? false;
        const value = own?.rate ?? offered?.rate ?? "";
        const invalid = own !== undefined && normalizeRate(own.rate) === null;
        return (
          <label className="waterfall-rate" key={currency}>
            <span>1 {perReport ? reportCurrency : currency} =</span>
            <input
              type="text"
              inputMode="decimal"
              value={value}
              aria-invalid={invalid}
              onChange={(e) =>
                onChange({ ...rates, [currency]: { currency, rate: e.target.value, perReport } })
              }
            />
            <span>{perReport ? currency : reportCurrency}</span>
            {own && (
              <button
                type="button"
                className="icon-btn"
                title={t("waterfall.rateReset", { rate: offered?.rate ?? "—" })}
                aria-label={t("waterfall.rateReset", { rate: offered?.rate ?? "—" })}
                onClick={() => {
                  const { [currency]: _removed, ...rest } = rates;
                  onChange(rest);
                }}
              >
                ↺
              </button>
            )}
          </label>
        );
      })}
    </div>
  );
}

/// The chart's bottom line: did the period end above or below where it began.
function BalanceChange({ data }: { data: WaterfallResponse }) {
  const t = useT();
  const opening = parseMoneyToMinor(data.opening) ?? 0;
  const change = (parseMoneyToMinor(data.closing) ?? 0) - opening;
  const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  return (
    <div className={`waterfall-change waterfall-change--${direction}`}>
      <span className="waterfall-change-label">{t("waterfall.changeLabel")}</span>
      <span className="waterfall-change-mark" aria-hidden="true">
        {change > 0 ? "▲" : change < 0 ? "▼" : "="}
      </span>
      <strong>
        {signedMoney(change)} {data.currency}
      </strong>
      {opening > 0 && change !== 0 && (
        <span className="waterfall-change-share">
          {change > 0 ? "+" : ""}
          {((change / opening) * 100).toFixed(1)}%
        </span>
      )}
    </div>
  );
}

function balanceChangeText(data: WaterfallResponse): string {
  const change = (parseMoneyToMinor(data.closing) ?? 0) - (parseMoneyToMinor(data.opening) ?? 0);
  return `${signedMoney(change)} ${data.currency}`;
}

interface ChartActionsProps {
  columns: WaterfallColumn[];
  currency: string;
  categories: Category[];
  steps: number[];
  orientation: WaterfallOrientation;
  from: string;
  to: string;
  periodLabel: string;
  change: string;
  rateLabel: string;
  onError: (message: string) => void;
}

/// Takes the chart out of the app: as a picture on the clipboard, or saved where
/// the browser doesn't allow that, and its numbers as a spreadsheet.
function ChartActions({
  columns,
  currency,
  categories,
  steps,
  orientation,
  from,
  to,
  periodLabel,
  change,
  rateLabel,
  onError,
}: ChartActionsProps) {
  const t = useT();
  const { locale } = useI18n();
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const columnLabel = useColumnLabel(byId);
  const [copyState, setCopyState] = useState<"copying" | "copied" | "downloaded" | null>(null);

  async function copy() {
    setCopyState("copying");
    const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
    const scale = waterfallScale(columns);
    const canvas = renderWaterfallImage({
      title: `${t("tabs.waterfall")} · ${periodLabel}`,
      changeLabel: t("waterfall.changeLabel"),
      change,
      orientation,
      min: scale.min,
      max: scale.max,
      ticks: scale.ticks.map((tick) => ({ value: tick, label: compact.format(tick / 100) })),
      zones: waterfallZones(columns).map((zone) => ({
        ...zone,
        title: `${t(zone.kind === "income" ? "waterfall.panelIncome" : "waterfall.panelExpense")} ${
          (zone.totalMinor > 0 ? "+" : "") + wholeMoney(zone.totalMinor)
        }`,
      })),
      columns: columns.map((column) => {
        const shown = isTotal(column) ? column.endMinor : column.deltaMinor;
        const carved = column.categoryId !== null && carvedOutSteps(column.categoryId, steps, categories).length > 0;
        return {
          column,
          label: columnLabel(column),
          note: isTotal(column)
            ? shortDate(column.kind === "opening" ? from : to)
            : carved
              ? t("waterfall.theRest")
              : undefined,
          dotColor: column.categoryId === null ? undefined : byId.get(column.categoryId)?.color,
          value: (!isTotal(column) && shown > 0 ? "+" : "") + wholeMoney(shown),
        };
      }),
      currency,
    });
    try {
      setCopyState(await copyOrDownloadPng(canvas, "waterfall.png"));
      window.setTimeout(() => setCopyState(null), 2500);
    } catch (e) {
      setCopyState(null);
      onError(String(e));
    }
  }

  async function exportXlsx() {
    const sheet = buildWaterfallSheet(columns, {
      title: t("tabs.waterfall"),
      period: t("report.rangeLabel"),
      periodValue: periodLabel,
      currency: t("waterfall.currencyLabel"),
      currencyValue: currency,
      rate: t("waterfall.rateModeLabel"),
      rateValue: rateLabel,
      change: t("waterfall.changeLabel"),
      colColumn: t("waterfall.xlsx.colColumn"),
      colSection: t("waterfall.xlsx.colSection"),
      colChange: t("waterfall.tooltipChange"),
      colBalance: t("waterfall.xlsx.colBalance"),
      section: (kind) => t(`waterfall.xlsx.section.${SHEET_SECTIONS[kind]}`),
      columnName: (column) => {
        if (column.categoryId === null) return columnLabel(column);
        const name = categoryPath(column.categoryId, byId);
        return carvedOutSteps(column.categoryId, steps, categories).length > 0
          ? `${name} (${t("waterfall.theRest")})`
          : name;
      },
    });
    try {
      await downloadWaterfallXlsx(sheet, `waterfall_${from}_${to}_${currency}.xlsx`, t("tabs.waterfall"));
    } catch (e) {
      onError(String(e));
    }
  }

  return (
    <span className="waterfall-chart-actions">
      <button type="button" className="waterfall-copy" disabled={copyState !== null} onClick={copy}>
        {t(`waterfall.image.${copyState ?? "copy"}`)}
      </button>
      <button type="button" className="waterfall-copy" onClick={exportXlsx}>
        {t("waterfall.xlsx.export")}
      </button>
    </span>
  );
}

interface ChartProps {
  columns: WaterfallColumn[];
  currency: string;
  categories: Category[];
  steps: number[];
  orientation: WaterfallOrientation;
  from: string;
  to: string;
  onOpen: (column: WaterfallColumn) => void;
}

function WaterfallChart({ columns, currency, categories, steps, orientation, from, to, onOpen }: ChartProps) {
  const t = useT();
  const { locale } = useI18n();
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const columnLabel = useColumnLabel(byId);
  const scale = useMemo(() => waterfallScale(columns), [columns]);
  const [hover, setHover] = useState<{ column: WaterfallColumn; x: number; y: number } | null>(null);

  const compact = useMemo(
    () => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }),
    [locale],
  );
  const pct = (v: number) => ((v - scale.min) / (scale.max - scale.min)) * 100;
  const incomeTotal = columns.filter(isIncome).reduce((sum, c) => sum + c.deltaMinor, 0);
  const expenseTotal = columns.filter(isExpense).reduce((sum, c) => sum - c.deltaMinor, 0);
  // The one axis the whole picture hangs on: up the page or along it.
  const vertical = orientation === "vertical";
  const along = vertical ? "bottom" : "left";

  return (
    <div
      className={`waterfall-chart waterfall-chart--${orientation}`}
      role="group"
      aria-label={t("waterfall.chartLabel")}
      style={
        vertical
          ? { minWidth: 60 + 8 + columns.length * MIN_COLUMN_WIDTH }
          : { minHeight: 28 + columns.length * MIN_ROW_HEIGHT }
      }
    >
      <div className="waterfall-grid" aria-hidden="true">
        {scale.ticks.map((tick) => (
          <span
            key={tick}
            className={`waterfall-gridline${tick === 0 ? " waterfall-gridline--zero" : ""}`}
            style={{ [along]: `${pct(tick)}%` }}
          >
            <span className="waterfall-tick">{compact.format(tick / 100)}</span>
          </span>
        ))}
      </div>
      <div className="waterfall-columns">
        {waterfallZones(columns).map((zone) => {
          const start = `${(zone.start / columns.length) * 100}%`;
          const size = `${(zone.count / columns.length) * 100}%`;
          return (
            <div
              key={zone.kind}
              className={`waterfall-zone waterfall-zone--${zone.kind}`}
              style={vertical ? { left: start, width: size } : { top: start, height: size }}
            >
              <span className="waterfall-zone-title">
                {t(zone.kind === "income" ? "waterfall.panelIncome" : "waterfall.panelExpense")}{" "}
                {(zone.totalMinor > 0 ? "+" : "") + wholeMoney(zone.totalMinor)}
              </span>
            </div>
          );
        })}
        {columns.map((column, index) => {
          const low = pct(Math.min(column.startMinor, column.endMinor));
          const high = pct(Math.max(column.startMinor, column.endMinor));
          const label = columnLabel(column);
          const fullLabel = column.categoryId === null ? label : categoryPath(column.categoryId, byId);
          const color = column.categoryId === null ? undefined : byId.get(column.categoryId)?.color;
          const shown = isTotal(column) ? column.endMinor : column.deltaMinor;
          return (
            <button
              key={column.key}
              type="button"
              className={`waterfall-column waterfall-column--${column.kind}`}
              aria-label={`${fullLabel}: ${money(shown)} ${currency}`}
              onClick={() => {
                setHover(null);
                onOpen(column);
              }}
              onMouseEnter={(e) => setHover({ column, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => setHover({ column, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHover(null)}
            >
              <span className="waterfall-column-plot">
                {index < columns.length - 1 && (
                  <span className="waterfall-connector" style={{ [along]: `${pct(column.endMinor)}%` }} />
                )}
                <span
                  className="waterfall-bar"
                  style={vertical ? { bottom: `${low}%`, height: `${high - low}%` } : { left: `${low}%`, width: `${high - low}%` }}
                />
                <span className="waterfall-value" style={{ [along]: `${high}%` }}>
                  {isTotal(column) ? wholeMoney(shown) : (shown > 0 ? "+" : "") + wholeMoney(shown)}
                </span>
              </span>
              <span className="waterfall-name" title={fullLabel}>
                {color && <span className="waterfall-dot" style={{ background: color }} />}
                {label}
                {isTotal(column) && (
                  <span className="waterfall-date">{shortDate(column.kind === "opening" ? from : to)}</span>
                )}
                {column.categoryId !== null && carvedOutSteps(column.categoryId, steps, categories).length > 0 && (
                  <span className="waterfall-date">{t("waterfall.theRest")}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {hover && (
        <div
          className="waterfall-tooltip"
          style={{
            left: Math.min(hover.x + 14, window.innerWidth - 340),
            top: Math.min(hover.y + 14, window.innerHeight - 160),
          }}
        >
          <div className="waterfall-tooltip-title">
            {hover.column.categoryId === null ? columnLabel(hover.column) : categoryPath(hover.column.categoryId, byId)}
          </div>
          <table>
            <tbody>
              {!isTotal(hover.column) && (
                <>
                  <tr>
                    <td>{t("waterfall.tooltipChange")}</td>
                    <td className="num">
                      {signedMoney(hover.column.deltaMinor)} {currency}
                    </td>
                  </tr>
                  <tr>
                    <td>{t("waterfall.tooltipBefore")}</td>
                    <td className="num">{money(hover.column.startMinor)}</td>
                  </tr>
                </>
              )}
              <tr>
                <td>{t(isTotal(hover.column) ? "waterfall.colTotal" : "waterfall.tooltipAfter")}</td>
                <td className="num">
                  {money(hover.column.endMinor)}
                  {isTotal(hover.column) ? ` ${currency}` : ""}
                </td>
              </tr>
              {isExpense(hover.column) && expenseTotal !== 0 && (
                <tr>
                  <td>{t("waterfall.tooltipShareExpense")}</td>
                  <td className="num">{((Math.abs(hover.column.deltaMinor) / expenseTotal) * 100).toFixed(1)}%</td>
                </tr>
              )}
              {isIncome(hover.column) && incomeTotal !== 0 && (
                <tr>
                  <td>{t("waterfall.tooltipShareIncome")}</td>
                  <td className="num">{((hover.column.deltaMinor / incomeTotal) * 100).toFixed(1)}%</td>
                </tr>
              )}
            </tbody>
          </table>
          {hover.column.categoryId !== null &&
            carvedOutSteps(hover.column.categoryId, steps, categories).length > 0 && (
              <p className="waterfall-tooltip-hint">
                {t("waterfall.tooltipExcept", {
                  categories: carvedOutSteps(hover.column.categoryId, steps, categories)
                    .map((id) => byId.get(id)?.name)
                    .join(", "),
                })}
              </p>
            )}
          {hover.column.kind === "system" && (
            <p className="waterfall-tooltip-hint">{t("waterfall.systemHint")}</p>
          )}
          <p className="waterfall-tooltip-hint">{t("waterfall.tooltipClick")}</p>
        </div>
      )}
    </div>
  );
}

interface TreeProps {
  kind: "income" | "expense";
  categories: Category[];
  /** Current amounts: what each row shows. */
  amounts: Map<number, number>;
  /** Amounts before any column, so rows don't jump while the user adds them. */
  order: Map<number, number>;
  /** The list starts from these children; `null` is the top level. */
  rootParent?: number | null;
  /** Columns are numbered in the list, or left out of it when `hideSteps`. */
  steps: number[];
  hideSteps?: boolean;
  expandedKey: string;
  /** Rows covered by a group's column can't be picked; the panel greys them out. */
  disableCovered?: boolean;
  onPick: (category: Category) => void;
  onAdd?: (category: Category) => void;
}

/// The categories with money this period, largest first.
function CategoryTree({
  kind,
  categories,
  amounts,
  order,
  rootParent = null,
  steps,
  hideSteps = false,
  expandedKey,
  disableCovered = false,
  onPick,
  onAdd,
}: TreeProps) {
  const t = useT();
  const [expanded, setExpanded] = useViewState<number[]>(expandedKey, []);

  const childrenOf = useMemo(() => {
    const map = new Map<number | null, Category[]>();
    for (const c of categories) {
      if (c.kind !== kind) continue;
      if (hideSteps && steps.includes(c.id)) continue;
      const shown = hideSteps ? amounts.get(c.id) ?? 0 : order.get(c.id) ?? 0;
      if (shown === 0 && !steps.includes(c.id)) continue;
      const list = map.get(c.parentId) ?? [];
      list.push(c);
      map.set(c.parentId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0));
    }
    return map;
  }, [categories, kind, amounts, order, steps, hideSteps]);

  // Numbered within the section: the panel lists income and expenses separately.
  const ownSteps = steps.filter((id) => categories.find((x) => x.id === id)?.kind === kind);

  function renderNode(c: Category, depth: number) {
    const kids = childrenOf.get(c.id) ?? [];
    const open = expanded.includes(c.id);
    const stepNumber = hideSteps ? 0 : ownSteps.indexOf(c.id) + 1;
    // A column of its own stays clickable, to remove it, even inside a group's column.
    const coveredId = disableCovered && stepNumber === 0 ? coveredByStep(c.id, steps, categories) : null;
    const coveredName = categories.find((x) => x.id === coveredId)?.name;
    return (
      <div key={c.id}>
        <div
          className={`waterfall-pick${stepNumber > 0 ? " waterfall-pick--on" : ""}${coveredId !== null ? " waterfall-pick--covered" : ""}`}
          style={{ paddingLeft: depth * 14 }}
        >
          {kids.length > 0 ? (
            <button
              type="button"
              className="waterfall-pick-caret"
              aria-label={t(open ? "waterfall.collapse" : "waterfall.expand")}
              title={t(open ? "waterfall.collapse" : "waterfall.expand")}
              aria-expanded={open}
              onClick={() =>
                setExpanded((list) => (open ? list.filter((id) => id !== c.id) : [...list, c.id]))
              }
            >
              {open ? "▾" : "▸"}
            </button>
          ) : (
            <span className="waterfall-pick-caret" />
          )}
          <button
            type="button"
            className="waterfall-pick-main"
            aria-pressed={stepNumber > 0}
            disabled={coveredId !== null}
            title={coveredId !== null ? t("waterfall.coveredBy", { group: coveredName ?? "" }) : undefined}
            onClick={() => onPick(c)}
          >
            <span className="waterfall-dot" style={{ background: c.color }} />
            <span className="waterfall-pick-name">{c.name}</span>
            {stepNumber > 0 && <span className="waterfall-pick-number">{stepNumber}</span>}
            <span className="waterfall-pick-amount">{money(amounts.get(c.id) ?? 0)}</span>
          </button>
          {onAdd && (
            <button
              type="button"
              className="icon-btn waterfall-pick-add"
              title={t("waterfall.addStep")}
              aria-label={t("waterfall.addStep")}
              onClick={() => onAdd(c)}
            >
              +
            </button>
          )}
        </div>
        {open && kids.map((kid) => renderNode(kid, depth + 1))}
      </div>
    );
  }

  return <>{(childrenOf.get(rootParent) ?? []).map((c) => renderNode(c, 0))}</>;
}

interface PanelProps {
  data: WaterfallResponse;
  categories: Category[];
  steps: number[];
  viewId: number;
  onToggle: (id: number) => void;
  onMove: (id: number, dir: -1 | 1) => void;
}

/// Which categories get a column, and in what order.
function StepsPanel({ data, categories, steps, viewId, onToggle, onMove }: PanelProps) {
  const t = useT();
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const { amounts } = useMemo(() => allocateToSteps(data, categories, steps), [data, categories, steps]);
  const order = useMemo(() => allocateToSteps(data, categories, []).amounts, [data, categories]);

  function renderGroup(kind: "income" | "expense") {
    const own = steps.filter((id) => byId.get(id)?.kind === kind);
    const hasMoney = categories.some((c) => c.kind === kind && (order.get(c.id) ?? 0) !== 0);
    return (
      <section key={kind}>
        <h4>{t(kind === "income" ? "waterfall.panelIncome" : "waterfall.panelExpense")}</h4>
        {own.map((id, index) => {
          const canDown = canMoveStep(steps, id, 1, categories);
          const canUp = canMoveStep(steps, id, -1, categories);
          return (
            <div className="waterfall-step" key={id}>
              <span className="waterfall-dot" style={{ background: byId.get(id)?.color }} />
              <span className="waterfall-step-name" title={categoryPath(id, byId)}>{byId.get(id)?.name}</span>
              <span className="waterfall-pick-amount">{money(amounts.get(id) ?? 0)}</span>
              <span className="waterfall-step-actions">
                {/* Both arrows always take their place: down on the left, up on the right. */}
                <button
                  type="button"
                  className={`icon-btn${index < own.length - 1 ? "" : " waterfall-step-action--off"}`}
                  disabled={!canDown}
                  title={t(canDown || index >= own.length - 1 ? "waterfall.moveDown" : "waterfall.nestedFirst")}
                  aria-label={t("waterfall.moveDown")}
                  onClick={() => onMove(id, 1)}
                >
                  ▼
                </button>
                <button
                  type="button"
                  className={`icon-btn${index > 0 ? "" : " waterfall-step-action--off"}`}
                  disabled={!canUp}
                  title={t(canUp || index <= 0 ? "waterfall.moveUp" : "waterfall.nestedFirst")}
                  aria-label={t("waterfall.moveUp")}
                  onClick={() => onMove(id, -1)}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={t("waterfall.removeStep")}
                  aria-label={t("waterfall.removeStep")}
                  onClick={() => onToggle(id)}
                >
                  ×
                </button>
              </span>
            </div>
          );
        })}
        {!hasMoney && <p className="hint">{t("waterfall.pickerEmpty")}</p>}
        <div className="waterfall-tree">
          <CategoryTree
            kind={kind}
            categories={categories}
            amounts={amounts}
            order={order}
            steps={steps}
            expandedKey={`report.${viewId}.expandedCategories`}
            disableCovered
            onPick={(c) => onToggle(c.id)}
          />
        </div>
      </section>
    );
  }

  return (
    <aside className="waterfall-panel">
      <h3>{t("waterfall.panelTitle")}</h3>
      <p className="hint">{t("waterfall.panelHint")}</p>
      {renderGroup("income")}
      {renderGroup("expense")}
    </aside>
  );
}

interface DetailProps {
  column: WaterfallColumn;
  data: WaterfallResponse;
  categories: Category[];
  steps: number[];
  rateMode: WaterfallRateMode;
  periodLabel: string;
  accountNameById: Map<number, string>;
  viewId: number;
  onClose: () => void;
  onDrill: (drill: WaterfallDrill, label: string, amount: number) => void;
  onAddStep: (id: number) => void;
}

/// What a clicked column consists of.
function ColumnDetailModal({
  column,
  data,
  categories,
  steps,
  rateMode,
  periodLabel,
  accountNameById,
  viewId,
  onClose,
  onDrill,
  onAddStep,
}: DetailProps) {
  const t = useT();
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const { amounts } = useMemo(() => allocateToSteps(data, categories, steps), [data, categories, steps]);
  const order = useMemo(() => allocateToSteps(data, categories, []).amounts, [data, categories]);
  const label = column.categoryId === null ? t(`waterfall.${column.kind}`) : categoryPath(column.categoryId, byId);
  const total = Math.abs(column.deltaMinor);
  const expandedKey = `report.${viewId}.detailExpanded`;

  let body: React.ReactNode = null;
  if (column.kind === "opening" || column.kind === "closing") {
    body = (
      <table className="cell-txns-table">
        <thead>
          <tr>
            <th>{t("waterfall.colAccount")}</th>
            <th className="waterfall-amount">{t("waterfall.colNative")}</th>
            <th className="waterfall-amount">
              {t("waterfall.colConverted")}, {data.currency}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.accounts.map((a) => (
            <tr key={a.accountId}>
              <td>{accountNameById.get(a.accountId) ?? `#${a.accountId}`}</td>
              <td className="waterfall-amount">
                {formatMoney(column.kind === "opening" ? a.openingNative : a.closingNative)} {a.currency}
              </td>
              <td className="waterfall-amount">
                {formatMoney(column.kind === "opening" ? a.opening : a.closing)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (column.kind === "system") {
    body = (
      <>
        <p className="waterfall-detail-hint">{t("waterfall.systemHint")}</p>
        <p>
          <strong>{t("waterfall.fx")}:</strong> {formatMoney(data.fxDifference)} {data.currency}
        </p>
        <p className="waterfall-detail-hint">
          {t(rateMode === "fixed" ? "waterfall.fxHintFixed" : "waterfall.fxHint")}
        </p>
        <p>
          <strong>{t("waterfall.adjustments")}:</strong> {formatMoney(data.adjustments)} {data.currency}
        </p>
        <p className="waterfall-detail-hint">{t("waterfall.adjustmentsHint")}</p>
      </>
    );
  } else {
    const section = isIncome(column) ? "income" : "expense";
    const isRest = column.categoryId === null;
    const uncategorized = !isRest
      ? 0
      : parseMoneyToMinor(section === "income" ? data.uncategorizedIncome : data.uncategorizedExpense) ?? 0;
    const whole = isRest
      ? drillRest(section, categories, steps)
      : drillCategory(column.categoryId!, categories, steps);
    const pick = (c: Category) =>
      onDrill(drillCategory(c.id, categories, steps), c.name, amounts.get(c.id) ?? 0);
    const kidsTotal = categories
      .filter((c) => column.categoryId !== null && c.parentId === column.categoryId && !steps.includes(c.id))
      .reduce((sum, c) => sum + (amounts.get(c.id) ?? 0), 0);
    const own = column.categoryId === null ? 0 : (amounts.get(column.categoryId) ?? 0) - kidsTotal;
    body = (
      <>
        <div className="waterfall-detail-actions">
          <button type="button" onClick={() => onDrill(whole, label, total)}>
            {t("waterfall.detailAll")}
          </button>
        </div>
        <CategoryTree
          kind={section}
          categories={categories}
          amounts={amounts}
          order={order}
          rootParent={column.categoryId}
          steps={steps}
          hideSteps
          expandedKey={expandedKey}
          onPick={pick}
          onAdd={isRest ? (c) => onAddStep(c.id) : undefined}
        />
        {column.categoryId !== null && own !== 0 && (
          <div className="waterfall-pick">
            <span className="waterfall-pick-caret" />
            <button
              type="button"
              className="waterfall-pick-main"
              onClick={() => onDrill(drillOwn(column.categoryId!, categories), label, own)}
            >
              <span className="waterfall-pick-name">{t("waterfall.detailOwn")}</span>
              <span className="waterfall-pick-amount">{money(own)}</span>
            </button>
          </div>
        )}
        {uncategorized !== 0 && (
          // Lines its amount up with the rows above, which end in a "+" button.
          <div className="waterfall-pick" style={{ paddingRight: 34 }}>
            <span className="waterfall-pick-caret" />
            <button
              type="button"
              className="waterfall-pick-main"
              onClick={() =>
                onDrill(drillUncategorized(section, categories), t("waterfall.detailUncategorized"), uncategorized)
              }
            >
              <span className="waterfall-pick-name">{t("waterfall.detailUncategorized")}</span>
              <span className="waterfall-pick-amount">{money(uncategorized)}</span>
            </button>
          </div>
        )}
        {total === 0 && <p className="hint">{t("waterfall.detailEmpty")}</p>}
      </>
    );
  }

  const shown = column.kind === "opening" || column.kind === "closing" ? column.endMinor : column.deltaMinor;
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal waterfall-detail-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div className="cell-txns-title">
            <h3>
              {label}: {money(shown)} {data.currency}
            </h3>
            <span className="cell-txns-subtitle">{periodLabel}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")} type="button">
            ×
          </button>
        </header>
        <div className="modal-body">{body}</div>
      </div>
    </div>,
    document.body,
  );
}
