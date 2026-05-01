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
  LINK_ERROR_CODES,
  LinkErrorCode,
  Transaction,
  TransactionCategoryView,
  TxnLink,
  linkTransactions,
  listAccounts,
  listTransactionLinks,
  listTransactions,
  listTransactionsCategories,
  unlinkTransaction,
  updateTransactionComment,
} from "../lib/api";
import { formatMoney, parseMoneyToMinor } from "../lib/money";
import { CategoriesCell } from "./transactions/CategoriesCell";

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
const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = COLUMN_KEYS;

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
  const [txnCategories, setTxnCategories] = useState<TransactionCategoryView[]>(
    [],
  );
  const [categoriesVersion, setCategoriesVersion] = useState(0);
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
  // Hover state: the exact row under the cursor plus its accountId, so we can
  // tint every row of the same account softly while highlighting the hovered
  // one strongly. Both fields update together to keep the two cues in sync.
  const [hovered, setHovered] = useState<{ id: number; accountId: number } | null>(
    null,
  );
  // Transfer-link state. `links` mirrors the backend table; `pendingLinkTxnId`
  // holds the txn whose 🔗 cell was clicked first and is now waiting for a
  // partner. `unlinkConfirm` defers an actual unlink until the user confirms
  // — matches user spec: linking is unconfirmed, unlinking is.
  const [links, setLinks] = useState<TxnLink[]>([]);
  const [pendingLinkTxnId, setPendingLinkTxnId] = useState<number | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [unlinkConfirm, setUnlinkConfirm] = useState<number | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    listTransactionsCategories(undefined)
      .then((tc) => {
        if (!cancelled) setTxnCategories(tc);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [version, categoriesVersion]);

  useEffect(() => {
    let cancelled = false;
    listTransactionLinks(undefined)
      .then((ls) => {
        if (!cancelled) setLinks(ls);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  // Map of txn id → partner txn id. A transaction is part of at most one
  // link, so this lookup is unambiguous.
  const linkPartnerById = useMemo(() => {
    const m = new Map<number, number>();
    for (const l of links) {
      m.set(l.txnAId, l.txnBId);
      m.set(l.txnBId, l.txnAId);
    }
    return m;
  }, [links]);

  const categoriesByTxn = useMemo(() => {
    const map = new Map<number, TransactionCategoryView[]>();
    for (const tc of txnCategories) {
      const arr = map.get(tc.transactionId);
      if (arr) arr.push(tc);
      else map.set(tc.transactionId, [tc]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.position - b.position);
    }
    return map;
  }, [txnCategories]);

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
  // 5 fixed money/date columns + always-visible 🔗 column + optional togglables.
  const visibleColCount = 5 + 1 + visibleColumns.length;

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

  // Auto-clear transient link errors so the banner doesn't linger.
  useEffect(() => {
    if (!linkError) return;
    const handle = window.setTimeout(() => setLinkError(null), 4000);
    return () => window.clearTimeout(handle);
  }, [linkError]);

  // Cancel a pending link whenever the user clicks anywhere outside the
  // 🔗 column. Clicks *inside* `.col-link` are handled by the cell itself
  // (selection / cancel-on-anchor). Clicks on the cancel button in the
  // pending banner also leave the column, so they cancel naturally.
  useEffect(() => {
    if (pendingLinkTxnId === null) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".col-link")) return;
      if (target.closest(".txn-link-pending-banner")) return;
      setPendingLinkTxnId(null);
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [pendingLinkTxnId]);

  function localizedLinkError(code: string): string {
    if ((LINK_ERROR_CODES as string[]).includes(code)) {
      return t(`transactions.linkError.${code as LinkErrorCode}`);
    }
    return code;
  }

  async function refreshLinks() {
    try {
      const ls = await listTransactionLinks(undefined);
      setLinks(ls);
    } catch (e) {
      setError(String(e));
    }
  }

  async function commitLink(aId: number, bId: number) {
    try {
      await linkTransactions(aId, bId);
      setPendingLinkTxnId(null);
      setLinkError(null);
      await refreshLinks();
    } catch (e) {
      setLinkError(localizedLinkError(String(e)));
    }
  }

  async function commitUnlink(txnId: number) {
    try {
      await unlinkTransaction(txnId);
      setUnlinkConfirm(null);
      await refreshLinks();
    } catch (e) {
      setError(String(e));
    }
  }

  // Click on a 🔗 cell — drives the pending state machine. Categorisation
  // is intentionally untouched: per product spec, links and categories
  // coexist freely.
  function onLinkCellClick(x: Transaction) {
    const partnerId = linkPartnerById.get(x.id);
    if (partnerId !== undefined) {
      // Already linked → ask before breaking the link (creating is silent
      // but breaking warrants explicit confirmation).
      setUnlinkConfirm(x.id);
      return;
    }
    if (pendingLinkTxnId === null) {
      setPendingLinkTxnId(x.id);
      setLinkError(null);
      return;
    }
    if (pendingLinkTxnId === x.id) {
      // Re-clicking the same anchor cancels.
      setPendingLinkTxnId(null);
      return;
    }
    // Pre-flight validation matching the backend rules so the user gets
    // immediate feedback without an extra round-trip.
    const anchor = txns.find((t) => t.id === pendingLinkTxnId);
    if (!anchor) {
      setPendingLinkTxnId(null);
      return;
    }
    if (anchor.accountId === x.accountId) {
      setLinkError(t("transactions.linkError.link.same_account"));
      return;
    }
    const anchorIncoming = anchor.credit !== "0.00";
    const targetIncoming = x.credit !== "0.00";
    if (anchorIncoming === targetIncoming) {
      setLinkError(t("transactions.linkError.link.same_direction"));
      return;
    }
    if (linkPartnerById.has(x.id)) {
      setLinkError(t("transactions.linkError.link.already_linked"));
      return;
    }
    void commitLink(anchor.id, x.id);
  }

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
        {pendingLinkTxnId !== null && (
          <div className="txn-link-pending-banner">
            <span>{t("transactions.linkPickPartner")}</span>
            <button
              type="button"
              onClick={() => setPendingLinkTxnId(null)}
            >
              {t("common.cancel")}
            </button>
          </div>
        )}
        {linkError && <div className="txn-link-error">{linkError}</div>}
        <table>
          <thead ref={theadRef}>
            <tr>
              <th className="col-fixed col-account">{t("transactions.tableAccount")}</th>
              <th className="col-fixed col-date">{t("transactions.tableDate")}</th>
              <th className="col-fixed num">{t("transactions.tableCredit")}</th>
              <th className="col-fixed num">{t("transactions.tableDebit")}</th>
              <th className="col-fixed num col-divider">
                {t("transactions.tableBalance")}
              </th>
              <th
                className="col-link"
                title={t("transactions.tableLinkTitle")}
              >
                🔗
              </th>
              {showCategory && (
                <th className="col-category">{t("transactions.tableCategory")}</th>
              )}
              {showComment && (
                <th className="col-comment">{t("transactions.tableComment")}</th>
              )}
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
                  !prev || !sameLocalMonth(prev.occurredAtUtc, x.occurredAtUtc);
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
                const partnerId = linkPartnerById.get(x.id);
                const isLinkPartnerOfHover =
                  hovered !== null &&
                  linkPartnerById.get(hovered.id) === x.id;
                const rowClasses = [
                  x.isCorrecting ? "is-correcting" : "",
                  hovered?.accountId === x.accountId ? "is-hover-account" : "",
                  hovered?.id === x.id ? "is-hover-row" : "",
                  isLinkPartnerOfHover ? "is-link-partner" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                const isLinked = partnerId !== undefined;
                const isPendingAnchor = pendingLinkTxnId === x.id;
                // Icon visibility: a chain link only shows when this row has
                // an actual link or is the pending anchor. Empty otherwise —
                // the user asked for clean cells when nothing's connected.
                const showLinkIcon = isLinked || isPendingAnchor;
                const linkBtnClasses = [
                  "txn-link-btn",
                  isLinked ? "is-linked" : "",
                  isPendingAnchor ? "is-pending" : "",
                  !showLinkIcon ? "is-empty" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                let linkTitle: string;
                if (isLinked) {
                  linkTitle = t("transactions.linkLinkedTitle");
                } else if (isPendingAnchor) {
                  linkTitle = t("transactions.linkPendingTitle");
                } else if (pendingLinkTxnId !== null) {
                  linkTitle = t("transactions.linkPartnerCandidateTitle");
                } else {
                  linkTitle = t("transactions.linkStartTitle");
                }
                nodes.push(
                  <tr
                    key={x.id}
                    className={rowClasses}
                    onMouseEnter={() =>
                      setHovered({ id: x.id, accountId: x.accountId })
                    }
                    onMouseLeave={() =>
                      setHovered((cur) => (cur?.id === x.id ? null : cur))
                    }
                  >
                    <td className="col-fixed col-account">{accLabel}</td>
                    <td
                      className="col-fixed col-date"
                      title={formatInstantUtc(x.occurredAtUtc)}
                    >
                      {formatInstantLocal(x.occurredAtUtc)}{" "}
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
                    <td className="col-link">
                      <button
                        type="button"
                        className={linkBtnClasses}
                        title={linkTitle}
                        aria-label={linkTitle}
                        onClick={() => onLinkCellClick(x)}
                      >
                        {showLinkIcon ? "🔗" : ""}
                      </button>
                    </td>
                    {showCategory && (() => {
                      const totalMinor =
                        (parseMoneyToMinor(x.credit) ?? 0) +
                        (parseMoneyToMinor(x.debit) ?? 0);
                      const kind = x.credit !== "0.00" ? "income" : "expense";
                      const entries = categoriesByTxn.get(x.id) ?? [];
                      return (
                        <CategoriesCell
                          transactionId={x.id}
                          totalMinor={totalMinor}
                          kind={kind}
                          entries={entries}
                          onChanged={() => setCategoriesVersion((v) => v + 1)}
                        />
                      );
                    })()}
                    {showComment && (
                      <td className="col-comment">
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
      {unlinkConfirm !== null && (
        <div
          className="txn-link-confirm-overlay"
          onClick={() => setUnlinkConfirm(null)}
        >
          <div
            className="txn-link-confirm"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{t("transactions.linkUnlinkConfirmTitle")}</h3>
            <p>{t("transactions.linkUnlinkConfirmText")}</p>
            <div className="txn-link-confirm-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setUnlinkConfirm(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => commitUnlink(unlinkConfirm)}
              >
                {t("transactions.linkUnlinkConfirmYes")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function formatInstantLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${mi}`;
}

function formatInstantUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function formatDayOfWeekShort(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dow = new Intl.DateTimeFormat(locale, {
    weekday: "short",
  }).format(d);
  return dow.slice(0, 2).toUpperCase();
}

function sameLocalMonth(aIso: string, bIso: string): boolean {
  const a = new Date(aIso);
  const b = new Date(bIso);
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
  );
}

function formatMonthLabel(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = new Intl.DateTimeFormat(locale, {
    month: "long",
  }).format(d);
  const cap = month.charAt(0).toUpperCase() + month.slice(1);
  return `${cap} ${d.getFullYear()}`;
}
