import {
  CSSProperties,
  ReactElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { MultiSelectDropdown } from "../components/MultiSelectDropdown";
import { useI18n, useT } from "../i18n";
import {
  Account,
  Transaction,
  listAccounts,
  listTransactions,
  updateTransactionComment,
} from "../lib/api";
import { formatMoney } from "../lib/money";

type RowKind =
  | "correcting"
  | "incoming"
  | "outgoing"
  | "with_bank_description"
  | "with_comment";

const ROW_KINDS: RowKind[] = [
  "correcting",
  "incoming",
  "outgoing",
  "with_bank_description",
  "with_comment",
];

type ColumnKey = "category" | "comment" | "peer" | "bank_description";
const COLUMN_KEYS: ColumnKey[] = [
  "category",
  "comment",
  "peer",
  "bank_description",
];
const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = ["category", "comment"];

function rowMatchesKind(row: { isCorrecting: boolean; credit: string; debit: string; bankDescription: string | null; comment: string | null }, kind: RowKind): boolean {
  switch (kind) {
    case "correcting":
      return row.isCorrecting;
    case "incoming":
      return row.credit !== "0.00";
    case "outgoing":
      return row.debit !== "0.00";
    case "with_bank_description":
      return !!row.bankDescription && row.bankDescription.trim() !== "";
    case "with_comment":
      return !!row.comment && row.comment.trim() !== "";
  }
}

interface Props {
  selectedAccountIds: number[];
  onChangeSelectedAccountIds: (ids: number[]) => void;
  version: number;
  onImportTransactions: () => void;
}

function defaultDateFrom(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 2);
  return toDateInputValue(d);
}

function defaultDateTo(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 0);
  return toDateInputValue(d);
}

function toDateInputValue(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function TransactionsPage({
  selectedAccountIds,
  onChangeSelectedAccountIds,
  version,
  onImportTransactions,
}: Props) {
  const t = useT();
  const { locale } = useI18n();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedKinds, setSelectedKinds] = useState<RowKind[]>(() => [
    ...ROW_KINDS,
  ]);
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(() => [
    ...DEFAULT_VISIBLE_COLUMNS,
  ]);
  const [dateFrom, setDateFrom] = useState<string>(defaultDateFrom);
  const [dateTo, setDateTo] = useState<string>(defaultDateTo);
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  const [accountsInitialised, setAccountsInitialised] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAccounts(), listTransactions(undefined)])
      .then(([a, ts]) => {
        if (cancelled) return;
        setAccounts(a);
        setTxns(ts);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  // First-time default for the account filter: select all accounts. After this
  // initialisation the user owns the selection — clearing it stays cleared.
  useEffect(() => {
    if (accountsInitialised) return;
    if (accounts.length === 0) return;
    if (selectedAccountIds.length === 0) {
      onChangeSelectedAccountIds(accounts.map((a) => a.id));
    }
    setAccountsInitialised(true);
  }, [accounts, accountsInitialised, selectedAccountIds, onChangeSelectedAccountIds]);

  const scrollWrapRef = useRef<HTMLDivElement>(null);
  const theadRef = useRef<HTMLTableSectionElement>(null);
  const [theadHeight, setTheadHeight] = useState(0);

  useLayoutEffect(() => {
    const el = theadRef.current;
    if (!el) return;
    const update = () => setTheadHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const showCategory = visibleColumns.includes("category");
  const showComment = visibleColumns.includes("comment");
  const showPeer = visibleColumns.includes("peer");
  const showBankDescription = visibleColumns.includes("bank_description");
  const visibleColCount = 5 + visibleColumns.length; // account/date/credit/debit/balance + optional

  const visibleTxns = useMemo(() => {
    const fromMs = dateFrom ? Date.parse(dateFrom + "T00:00:00Z") : null;
    const toMs = dateTo ? Date.parse(dateTo + "T23:59:59.999Z") : null;
    const accountSet = new Set(selectedAccountIds);
    return txns.filter((x) => {
      if (!accountSet.has(x.accountId)) return false;
      const ts = Date.parse(x.occurredAtUtc);
      if (fromMs !== null && ts < fromMs) return false;
      if (toMs !== null && ts > toMs) return false;
      if (selectedKinds.length === 0) return false;
      return selectedKinds.some((k) => rowMatchesKind(x, k));
    });
  }, [txns, selectedAccountIds, selectedKinds, dateFrom, dateTo]);

  useLayoutEffect(() => {
    const el = scrollWrapRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleTxns, visibleColumns]);

  async function persistComment(id: number, raw: string) {
    const trimmed = raw.trim();
    const next = trimmed === "" ? null : trimmed;
    try {
      await updateTransactionComment(id, next);
      setTxns((prev) =>
        prev.map((tt) => (tt.id === id ? { ...tt, comment: next } : tt)),
      );
    } catch (e) {
      setError(String(e));
    }
  }

  const accountItems = accounts.map((a) => ({
    id: a.id,
    label: `${a.name || a.accountNumber || `#${a.id}`} · ${a.currency}`,
  }));

  return (
    <section className="page page--transactions">
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
              <span>{t("transactions.filterAccounts")}</span>
              <MultiSelectDropdown
                items={accountItems}
                selected={selectedAccountIds}
                onApply={onChangeSelectedAccountIds}
                allLabel={t("transactions.filterAccountsAll")}
                noneLabel={t("transactions.filterAccountsNone")}
                emptyItemsLabel={t("transactions.filterAccountsEmpty")}
                multiSelectedLabel={(count) =>
                  t("transactions.filterAccountsMany", { count })
                }
                applyLabel={t("transactions.applyButton")}
              />
            </label>
            <label className="filter-field">
              <span>{t("transactions.filterDateFrom")}</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </label>
            <label className="filter-field">
              <span>{t("transactions.filterDateTo")}</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </label>
            <label className="filter-field">
              <span>{t("transactions.filterKind")}</span>
              <MultiSelectDropdown<RowKind>
                items={ROW_KINDS.map((k) => ({
                  id: k,
                  label: t(`transactions.kind.${k}`),
                }))}
                selected={selectedKinds}
                onApply={setSelectedKinds}
                allLabel={t("transactions.filterKindAll")}
                noneLabel={t("transactions.filterKindNone")}
                emptyItemsLabel={t("transactions.filterKindAll")}
                multiSelectedLabel={(count) =>
                  t("transactions.filterKindMany", { count })
                }
                applyLabel={t("transactions.applyButton")}
              />
            </label>
            <label className="filter-field">
              <span>{t("transactions.filterColumns")}</span>
              <MultiSelectDropdown<ColumnKey>
                items={COLUMN_KEYS.map((k) => ({
                  id: k,
                  label: t(`transactions.column.${k}`),
                }))}
                selected={visibleColumns}
                onApply={setVisibleColumns}
                allLabel={t("transactions.filterColumnsAll")}
                noneLabel={t("transactions.filterColumnsNone")}
                emptyItemsLabel={t("transactions.filterColumnsAll")}
                multiSelectedLabel={(count) =>
                  t("transactions.filterColumnsMany", { count })
                }
                applyLabel={t("transactions.applyButton")}
              />
            </label>
            <button
              type="button"
              className="btn-primary filter-bar-action"
              onClick={onImportTransactions}
            >
              {t("toolbar.importTransactions")}
            </button>
          </div>
        )}
      </section>

      {error && <div className="error">{error}</div>}

      <div
        className="txns-wrap"
        ref={scrollWrapRef}
        style={
          theadHeight
            ? ({ "--thead-h": `${theadHeight}px` } as CSSProperties)
            : undefined
        }
      >
        <table>
          <thead ref={theadRef}>
            <tr>
              <th className="col-fixed">{t("transactions.tableAccount")}</th>
              <th className="col-fixed">{t("transactions.tableDate")}</th>
              <th className="col-fixed num">{t("transactions.tableCredit")}</th>
              <th className="col-fixed num">{t("transactions.tableDebit")}</th>
              <th className="col-fixed num col-divider">
                {t("transactions.tableBalance")}
              </th>
              {showCategory && <th>{t("transactions.tableCategory")}</th>}
              {showComment && <th>{t("transactions.tableComment")}</th>}
              {showPeer && <th>{t("transactions.tablePeer")}</th>}
              {showBankDescription && (
                <th>{t("transactions.tableBankDescription")}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {visibleTxns.length === 0 ? (
              <tr>
                <td colSpan={visibleColCount} className="empty">
                  {t("transactions.empty")}
                </td>
              </tr>
            ) : (
              visibleTxns.flatMap((x, i) => {
                const acc = accountById.get(x.accountId);
                const accLabel = acc
                  ? `${acc.name || acc.accountNumber} · ${acc.currency}`
                  : `#${x.accountId}`;
                const prev = i > 0 ? visibleTxns[i - 1] : null;
                const isMonthStart =
                  !prev || !sameUtcMonth(prev.occurredAtUtc, x.occurredAtUtc);
                const nodes: ReactElement[] = [];
                if (isMonthStart) {
                  nodes.push(
                    <tr key={`sep:${x.id}`} className="month-separator">
                      <td colSpan={visibleColCount}>
                        {formatMonthLabel(x.occurredAtUtc, locale)}
                      </td>
                    </tr>,
                  );
                }
                nodes.push(
                  <tr key={x.id} className={x.isCorrecting ? "is-correcting" : ""}>
                    <td className="col-fixed">{accLabel}</td>
                    <td className="col-fixed">
                      {formatInstant(x.occurredAtUtc)}{" "}
                      <span className="dow">
                        ({formatDayOfWeekShort(x.occurredAtUtc, locale)})
                      </span>
                    </td>
                    <td className="col-fixed num">
                      {x.credit !== "0.00" ? (
                        <span className="amount-credit">
                          {formatMoney(x.credit)}
                        </span>
                      ) : (
                        ""
                      )}
                    </td>
                    <td className="col-fixed num">
                      {x.debit !== "0.00" ? (
                        <span className="amount-debit">
                          {formatMoney(x.debit)}
                        </span>
                      ) : (
                        ""
                      )}
                    </td>
                    <td className="col-fixed num col-divider">
                      {formatMoney(x.balance)}
                    </td>
                    {showCategory && <td className="cell-placeholder">—</td>}
                    {showComment && (
                      <td>
                        <input
                          key={`${x.id}:${x.comment ?? ""}`}
                          className="inline-edit"
                          defaultValue={x.comment ?? ""}
                          placeholder={t("transactions.commentPlaceholder")}
                          onBlur={(e) => {
                            const next =
                              e.target.value.trim() === ""
                                ? null
                                : e.target.value.trim();
                            if (next !== (x.comment ?? null)) {
                              void persistComment(x.id, e.target.value);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.currentTarget.blur();
                            } else if (e.key === "Escape") {
                              e.currentTarget.value = x.comment ?? "";
                              e.currentTarget.blur();
                            }
                          }}
                        />
                      </td>
                    )}
                    {showPeer && (
                      <td>
                        {x.isCorrecting
                          ? t("transactions.correctingLabel")
                          : x.peer ?? ""}
                      </td>
                    )}
                    {showBankDescription && (
                      <td>{x.bankDescription ?? ""}</td>
                    )}
                  </tr>,
                );
                return nodes;
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function formatDayOfWeekShort(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dow = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  }).format(d);
  return dow.slice(0, 2).toUpperCase();
}

function sameUtcMonth(aIso: string, bIso: string): boolean {
  const a = new Date(aIso);
  const b = new Date(bIso);
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth()
  );
}

function formatMonthLabel(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = new Intl.DateTimeFormat(locale, {
    month: "long",
    timeZone: "UTC",
  }).format(d);
  const cap = month.charAt(0).toUpperCase() + month.slice(1);
  return `${cap} ${d.getUTCFullYear()}`;
}
