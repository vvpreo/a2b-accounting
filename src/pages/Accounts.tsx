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
  ImportBatch,
  MonthRange,
  ValidationError,
  accountMonthlyStatus,
  createAccount,
  deleteAccount,
  deleteImportBatch,
  firstTransactionDate,
  getSetting,
  latestTransactions,
  listAccounts,
  listImportBatches,
  setSetting,
  updateAccount,
  validateBalanceChain,
} from "../lib/api";
import { ACCOUNT_PRESETS, findPresetByName } from "../lib/account-presets";
import { CRYPTO_CURRENCIES, FIAT_CURRENCIES } from "../lib/currencies";

const MONTH_DEPTH_OPTIONS = [3, 12, 36, "all"] as const;
type MonthDepth = (typeof MONTH_DEPTH_OPTIONS)[number];
const DEFAULT_MONTH_DEPTH: MonthDepth = 36;
const SETTING_KEY_ACTIVITY_MONTHS = "accounts_activity_months";

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
          <optgroup label={t("accounts.fieldCurrencyFiat")}>
            {FIAT_CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </optgroup>
          <optgroup label={t("accounts.fieldCurrencyCrypto")}>
            {CRYPTO_CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </optgroup>
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
}

export function AccountsPage({ onCreateAccount, version }: Props) {
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
        return;
      }
      const cells = await accountMonthlyStatus(monthRanges);
      setStatusCells(cells);
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
            <th></th>
          </tr>
        </thead>
        <tbody>
          {accounts.length === 0 ? (
            <tr>
              <td colSpan={8} className="empty">
                {t("accounts.empty")}
              </td>
            </tr>
          ) : (
            accounts.map((a) => (
              <Fragment key={a.id}>
                <tr className="account-row">
                  <td>{a.id}</td>
                  <td>{a.name}</td>
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
                  <td className="actions-cell">
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => setDetailAccountId(a.id)}
                    >
                      {t("accounts.actionDetails")}
                    </button>
                  </td>
                </tr>
                <tr className="account-strip-row">
                  <td className="account-strip-spacer" />
                  <td className="account-strip-spacer" />
                  <td colSpan={6} className="account-strip-cell">
                    <ActivityStrip
                      cells={cellsByAccount.get(a.id) ?? []}
                      hasTransactions={latestByAccount.has(a.id)}
                      registerViewport={registerStripViewport}
                      unregisterViewport={unregisterStripViewport}
                      onScroll={handleStripScroll}
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
    </section>
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

function ActivityStrip({
  cells,
  hasTransactions,
  registerViewport,
  unregisterViewport,
  onScroll,
}: {
  cells: AccountMonthCell[];
  hasTransactions: boolean;
  registerViewport: (el: HTMLDivElement) => void;
  unregisterViewport: (el: HTMLDivElement) => void;
  onScroll: (source: HTMLDivElement) => void;
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

  // Run width in the months row: count * 26px (cells) + (count - 1) * 2px
  // (inter-cell flex gap) = 28 * count - 2.
  function runWidthPx(count: number): number {
    return 28 * count - 2;
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
                <span
                  className={[
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
                    .join(" ")}
                  title={isPreAccount ? undefined : tooltip(c)}
                  aria-hidden={isPreAccount ? "true" : undefined}
                >
                  {isPreAccount ? "" : shortLabel(c)}
                </span>
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
