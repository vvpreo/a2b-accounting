import {
  Fragment,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useI18n, useT, useTPlural } from "../i18n";
import {
  Account,
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
  // Start of the current month in local time. The last full bucket is the
  // previous month; we walk back `count` months from there. Using local-time
  // month boundaries matches how the user perceives "month" elsewhere.
  const baseYear = now.getFullYear();
  const baseMonth = now.getMonth(); // 0-indexed
  const ranges: MonthRange[] = [];
  for (let i = count; i >= 1; i--) {
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
      const list = await listAccounts();
      setAccounts(list);
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

  const detailAccount =
    detailAccountId !== null
      ? accounts.find((a) => a.id === detailAccountId) ?? null
      : null;

  return (
    <section className="page">
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
          </div>
        )}
      </section>

      {error && <div className="error">{error}</div>}

      <table className="accounts-table">
        <thead>
          <tr>
            <th>{t("accounts.tableId")}</th>
            <th>{t("accounts.tableName")}</th>
            <th>{t("accounts.tableBank")}</th>
            <th>{t("accounts.tableCurrency")}</th>
            <th>{t("accounts.tableNumber")}</th>
            <th>{t("accounts.tableOwner")}</th>
            <th></th>
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
                  <td>{a.name}</td>
                  <td>{a.bank}</td>
                  <td>{a.currency}</td>
                  <td>{a.accountNumber}</td>
                  <td>{a.ownerName}</td>
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
                  <td colSpan={5}>
                    <ActivityStrip cells={cellsByAccount.get(a.id) ?? []} />
                  </td>
                </tr>
              </Fragment>
            ))
          )}
        </tbody>
      </table>

      <div className="accounts-add-row">
        <button
          type="button"
          className="btn-primary"
          onClick={onCreateAccount}
        >
          {t("accounts.add")}
        </button>
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

function ActivityStrip({ cells }: { cells: AccountMonthCell[] }) {
  const t = useT();
  const { locale } = useI18n();

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

  return (
    <div className="activity-strip">
      {cells.map((c, i) => {
        const prev = i > 0 ? cells[i - 1] : null;
        const yearChanged =
          prev !== null && c.yearMonth.slice(0, 4) !== prev.yearMonth.slice(0, 4);
        return (
          <Fragment key={c.yearMonth}>
            {yearChanged && (
              <span className="activity-strip-year-gap" aria-hidden="true" />
            )}
            <span
              className={[
                "activity-cell",
                `activity-cell--${c.status}`,
                c.balanceError ? "activity-cell--error" : "",
                c.uncategorizedCorrecting ? "activity-cell--dashed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={tooltip(c)}
            >
              {shortLabel(c)}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
