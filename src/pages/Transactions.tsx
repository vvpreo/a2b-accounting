import {
  CSSProperties,
  ReactElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { MultiSelectDropdown } from "../components/MultiSelectDropdown";
import { useI18n, useT } from "../i18n";
import {
  Account,
  LINK_ERROR_CODES,
  LinkErrorCode,
  Transaction,
  TransactionCategoryView,
  TransferDelta,
  TxnLink,
  WITHDRAWAL_ERROR_CODES,
  WithdrawalErrorCode,
  convertAmount,
  createCashWithdrawal,
  getSetting,
  linkTransactions,
  listAccounts,
  listTransactionLinks,
  listTransactions,
  listTransactionsCategories,
  listTransferDeltas,
  setSetting,
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

/// Two display modes for the Δ column. "percent" is the default:
///   - Only the credit (incoming) row of each linked pair shows a value, as
///     a signed percentage of the dictionary-fair amount; the debit row is
///     blank. Reads as "we lost / gained X% on this conversion."
///   - "absolute" mirrors the older behaviour and shows the signed delta in
///     each side's own currency on both rows.
/// Toggled via a click on the column header; the choice is persisted in
/// `app_settings` under DELTA_MODE_SETTING_KEY.
type DeltaMode = "percent" | "absolute";
const DELTA_MODES: DeltaMode[] = ["percent", "absolute"];
const DELTA_MODE_SETTING_KEY = "transactions.delta_display_mode";

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
  /// One-shot navigation hint. When set (typically right after the user clicks
  /// a month cell on the Accounts tab), the page snaps its date filter to that
  /// calendar month and then asks the host to clear the hint so the user can
  /// freely change filters without the navigation re-applying.
  pendingMonthFilter?: { accountId: number; yearMonth: string } | null;
  onPendingMonthFilterApplied?: () => void;
}

function defaultDateFrom(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 12);
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
  pendingMonthFilter,
  onPendingMonthFilterApplied,
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
  // True while the "Withdraw to cash" modal sits on top of the pending-link
  // overlay. Opening it doesn't cancel the pending link — the modal owns the
  // commit and clears the pending state itself on success or cancel.
  const [withdrawModalOpen, setWithdrawModalOpen] = useState(false);
  // FX-conversion deltas for every linked pair, keyed by txnId. Reloaded
  // alongside `links` and again whenever a background rate download finishes
  // — newly arrived rates can flip a row from "—" to a real number.
  const [deltas, setDeltas] = useState<Map<number, TransferDelta>>(
    () => new Map(),
  );
  // Δ-column display mode + the persistence flag. We start in "percent" and
  // upgrade to whatever's stored in app_settings on first effect tick — that
  // tiny flash on cold load is preferable to blocking the page render until
  // the setting comes back. Once `deltaModeLoaded` flips, subsequent toggles
  // get persisted; we don't write back the initial fetch result.
  const [deltaMode, setDeltaMode] = useState<DeltaMode>("percent");
  const [deltaModeLoaded, setDeltaModeLoaded] = useState(false);
  // Floating tooltip rendered via a portal so it isn't clipped by the
  // scrollable .txns-wrap. Coordinates are captured in viewport space at
  // mouseenter time and placed directly over document.body.
  const [tooltip, setTooltip] = useState<
    { x: number; y: number; text: string } | null
  >(null);

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

  // Restore the persisted Δ-column display mode once on mount.
  useEffect(() => {
    let cancelled = false;
    getSetting(DELTA_MODE_SETTING_KEY)
      .then((v) => {
        if (cancelled) return;
        if (v === "percent" || v === "absolute") setDeltaMode(v);
        setDeltaModeLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setDeltaModeLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleDeltaMode() {
    setDeltaMode((cur) => {
      const idx = DELTA_MODES.indexOf(cur);
      const next = DELTA_MODES[(idx + 1) % DELTA_MODES.length];
      // Only persist user-initiated changes — the initial restore above
      // doesn't bounce a write back to settings.
      if (deltaModeLoaded) {
        void setSetting(DELTA_MODE_SETTING_KEY, next).catch(() => {
          // Persist failures are silent — the in-memory toggle still works
          // for the rest of the session.
        });
      }
      return next;
    });
  }

  // Pull FX deltas for all linked pairs. Re-run whenever links change (new
  // pair created / broken) and whenever a background rate download finishes
  // — both can affect the answer. Errors are swallowed: a missing rate is
  // already represented by a `null` deltaMinor, so the page stays usable.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    const refresh = () => {
      listTransferDeltas()
        .then((ds) => {
          if (cancelled) return;
          const next = new Map<number, TransferDelta>();
          for (const d of ds) next.set(d.transactionId, d);
          setDeltas(next);
        })
        .catch(() => {
          // Don't surface — the column simply stays empty / dashed and the
          // user can still see / break links.
        });
    };

    refresh();
    listen("rates:download:completed", refresh)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Tauri event subsystem unavailable (shouldn't happen in production)
        // — we just lose the live refresh; the next mount cycle will fetch.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [version, links]);

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

  // Apply the one-shot month-navigation hint emitted by the Accounts tab:
  // pin dateFrom/dateTo to the picked month, mark accounts as initialised so
  // the auto-select-all branch above doesn't fight the host's per-account
  // selection, then ask the host to clear the hint. The selectedAccountIds
  // prop has already been narrowed to the clicked account on the host side.
  useEffect(() => {
    if (!pendingMonthFilter) return;
    const [yStr, mStr] = pendingMonthFilter.yearMonth.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    // `new Date(y, m, 0)` rolls back one day from the next month's first =
    // last day of month m (m is 1-indexed here, which is what we need).
    const lastDay = new Date(y, m, 0).getDate();
    setDateFrom(`${pendingMonthFilter.yearMonth}-01`);
    setDateTo(`${pendingMonthFilter.yearMonth}-${String(lastDay).padStart(2, "0")}`);
    setAccountsInitialised(true);
    onPendingMonthFilterApplied?.();
  }, [pendingMonthFilter, onPendingMonthFilterApplied]);

  const scrollWrapRef = useRef<HTMLDivElement>(null);
  const theadRef = useRef<HTMLTableSectionElement>(null);
  const [theadHeight, setTheadHeight] = useState(0);
  // Track the filter signature so we can scroll-to-bottom on the first
  // load and on every filter change, but *not* on in-place mutations of
  // existing rows (comment edits, withdrawal-paired cash inserts, etc).
  // Without this distinction, every keystroke that triggers a re-render
  // would yank the scroll position down to the latest transaction —
  // jarring when the user is mid-task. Null on mount → first effect run
  // always scrolls (initial population of the table).
  const lastFilterSigRef = useRef<string | null>(null);

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
  // Cash-kind accounts only — used to populate the "Withdraw to cash"
  // selector. Recomputed on every accounts change but the list is tiny in
  // practice (1–2 entries) and downstream consumers are stable, so this is
  // cheap.
  const cashAccounts = useMemo(
    () => accounts.filter((a) => a.kind === "cash"),
    [accounts],
  );
  // The transaction the pending-link banner is anchored on, if any. Null when
  // not in pending mode or when the source is no longer in the filtered list
  // (we still keep the banner up, but features that need the source — like
  // "Withdraw to cash" — gracefully hide).
  const pendingSourceTxn = useMemo(
    () =>
      pendingLinkTxnId === null
        ? null
        : txns.find((tt) => tt.id === pendingLinkTxnId) ?? null,
    [txns, pendingLinkTxnId],
  );
  const pendingSourceAccount = pendingSourceTxn
    ? accountById.get(pendingSourceTxn.accountId) ?? null
    : null;
  // "Withdraw to cash" only makes sense when the user started linking from
  // an outgoing transaction — the new cash entry will be the matching
  // incoming side.
  const canWithdrawToCash =
    pendingSourceTxn !== null &&
    pendingSourceTxn.debit !== "0.00" &&
    pendingSourceTxn.credit === "0.00";
  const showCategory = visibleColumns.includes("category");
  const showComment = visibleColumns.includes("comment");
  const showPeer = visibleColumns.includes("peer");
  const showBankDescription = visibleColumns.includes("bank_description");
  // 5 fixed money/date columns + always-visible 🔗 and Δ columns + optional
  // togglables.
  const visibleColCount = 5 + 2 + visibleColumns.length;

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

  // Only scroll to the bottom when the *filter shape* changes (or on
  // first mount). Row-level edits and additions keep the user's current
  // position so the table doesn't jump out from under them.
  const filterSignature = JSON.stringify({
    selectedAccountIds,
    selectedKinds,
    dateFrom,
    dateTo,
    visibleColumns,
  });
  useLayoutEffect(() => {
    const el = scrollWrapRef.current;
    if (!el) return;
    if (lastFilterSigRef.current !== filterSignature) {
      el.scrollTop = el.scrollHeight;
      lastFilterSigRef.current = filterSignature;
    }
  }, [visibleTxns, filterSignature]);

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
  // Escape works as a global cancel — handy when the cursor is parked on
  // a comment input or anywhere else focus might trap clicks.
  useEffect(() => {
    if (pendingLinkTxnId === null) return;
    // The Withdraw-to-cash modal sits on top of pending mode and owns its
    // own outside-click / Escape handling — disable the global cancel so
    // clicks inside the modal don't accidentally tear down the pending
    // state behind it.
    if (withdrawModalOpen) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".col-link")) return;
      if (target.closest(".txn-link-overlay")) return;
      if (target.closest(".withdraw-modal")) return;
      setPendingLinkTxnId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPendingLinkTxnId(null);
      }
    };
    window.addEventListener("click", onClick);
    // Capture-phase keydown so we beat any inputs that swallow Escape
    // (e.g. the comment field's onKeyDown handler) — the user expects
    // Escape to exit pending mode regardless of where focus sits.
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [pendingLinkTxnId, withdrawModalOpen]);

  function localizedLinkError(code: string): string {
    if ((LINK_ERROR_CODES as string[]).includes(code)) {
      return t(`transactions.linkError.${code as LinkErrorCode}`);
    }
    if ((WITHDRAWAL_ERROR_CODES as string[]).includes(code)) {
      return t(`transactions.linkError.${code as WithdrawalErrorCode}`);
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

  // Pre-flight check matching the backend's link rules. Returns a
  // localised reason if `target` is *not* a valid partner for the current
  // anchor, or null when a link can be created. Doesn't apply to the
  // anchor itself or when no anchor is set — callers gate on those.
  function linkInvalidReason(target: Transaction): string | null {
    if (pendingLinkTxnId === null) return null;
    if (pendingLinkTxnId === target.id) return null;
    if (linkPartnerById.has(target.id)) {
      return t("transactions.linkError.link.already_linked");
    }
    const anchor = txns.find((tt) => tt.id === pendingLinkTxnId);
    if (!anchor) return null;
    if (anchor.accountId === target.accountId) {
      return t("transactions.linkError.link.same_account");
    }
    const anchorIncoming = anchor.credit !== "0.00";
    const targetIncoming = target.credit !== "0.00";
    if (anchorIncoming === targetIncoming) {
      return t("transactions.linkError.link.same_direction");
    }
    return null;
  }

  // Click on a 🔗 / ❌ cell. Invalid candidates during pending mode are
  // silent no-ops — the ❌ icon and its hover tooltip already communicate
  // the rejection, so we don't surface separate error toasts.
  function onLinkCellClick(x: Transaction) {
    const partnerId = linkPartnerById.get(x.id);
    if (pendingLinkTxnId !== null) {
      if (pendingLinkTxnId === x.id) {
        setPendingLinkTxnId(null);
        return;
      }
      if (linkInvalidReason(x) !== null) {
        return; // silent no-op; ❌ tooltip already explains why
      }
      const anchor = txns.find((tt) => tt.id === pendingLinkTxnId);
      if (anchor) void commitLink(anchor.id, x.id);
      return;
    }
    if (partnerId !== undefined) {
      // Out of pending mode, clicking a linked row asks to break the link.
      setUnlinkConfirm(x.id);
      return;
    }
    setPendingLinkTxnId(x.id);
    setLinkError(null);
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
              <th
                className="col-delta"
                title={
                  deltaMode === "percent"
                    ? t("transactions.tableDeltaTitlePercent")
                    : t("transactions.tableDeltaTitleAbsolute")
                }
              >
                <button
                  type="button"
                  className="col-delta-toggle"
                  onClick={toggleDeltaMode}
                  aria-label={
                    deltaMode === "percent"
                      ? t("transactions.tableDeltaTitlePercent")
                      : t("transactions.tableDeltaTitleAbsolute")
                  }
                >
                  {deltaMode === "percent" ? "Δ%" : "Δ"}
                </button>
              </th>
              {showCategory && (
                <th className="col-category">{t("transactions.tableCategory")}</th>
              )}
              {showComment && (
                <th className="col-comment">{t("transactions.tableComment")}</th>
              )}
              {showPeer && (
                <th className="col-peer">{t("transactions.tablePeer")}</th>
              )}
              {showBankDescription && (
                <th className="col-bank-description">
                  {t("transactions.tableBankDescription")}
                </th>
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
                const invalidReason =
                  pendingLinkTxnId !== null && !isPendingAnchor
                    ? linkInvalidReason(x)
                    : null;
                // Icon decision is split by pending state:
                //  - in pending mode the table reads as a go/no-go pick:
                //    🔗 (anchor or valid candidate) vs. ❌ (invalid for any
                //    reason — including rows that are *already* linked).
                //  - out of pending mode the link icon only marks rows that
                //    actually have an existing link.
                let iconKind: "link" | "invalid" | "none";
                if (isPendingAnchor) {
                  iconKind = "link";
                } else if (pendingLinkTxnId !== null) {
                  iconKind = invalidReason !== null ? "invalid" : "link";
                } else if (isLinked) {
                  iconKind = "link";
                } else {
                  iconKind = "none";
                }
                // Visual variant of the chain icon. Green ("candidate") only
                // applies when a click would actually create a link; the
                // existing-link tint takes over outside pending mode.
                const isCandidate =
                  pendingLinkTxnId !== null &&
                  !isPendingAnchor &&
                  iconKind === "link" &&
                  invalidReason === null &&
                  !isLinked;
                // Outside pending mode, a click on an unlinked row's cell
                // *starts* a new pending. Mark the cell as "startable" so
                // hover can hint at that affordance with the same green
                // tint we use for the second-pick step.
                const isStartable =
                  pendingLinkTxnId === null && !isLinked;
                const linkBtnClasses = [
                  "txn-link-btn",
                  isLinked && pendingLinkTxnId === null ? "is-linked" : "",
                  isPendingAnchor ? "is-pending" : "",
                  isCandidate ? "is-candidate" : "",
                  isStartable ? "is-startable" : "",
                  iconKind === "invalid" ? "is-invalid" : "",
                  // Startable cells render a hidden ChainIcon that fades in
                  // on hover (see is-startable CSS), so they aren't truly
                  // "empty" and shouldn't suppress the hover background
                  // via the :not(.is-empty) rule.
                  iconKind === "none" && !isStartable ? "is-empty" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                let linkTitle: string;
                if (isLinked && pendingLinkTxnId === null) {
                  linkTitle = t("transactions.linkLinkedTitle");
                } else if (isPendingAnchor) {
                  linkTitle = t("transactions.linkPendingTitle");
                } else if (invalidReason !== null) {
                  linkTitle = invalidReason;
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
                    <td
                      className="col-fixed col-account"
                      onMouseEnter={(e) => {
                        if (!acc) return;
                        const r = e.currentTarget.getBoundingClientRect();
                        setTooltip({
                          x: r.left + r.width / 2,
                          y: r.top,
                          text: buildAccountTooltip(acc, t),
                        });
                      }}
                      onMouseLeave={() => setTooltip(null)}
                    >
                      {accLabel}
                    </td>
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
                        aria-label={linkTitle}
                        data-icon-kind={iconKind}
                        data-invalid-reason={invalidReason ?? ""}
                        data-pending={pendingLinkTxnId === null ? "false" : "true"}
                        data-anchor={isPendingAnchor ? "true" : "false"}
                        onClick={() => onLinkCellClick(x)}
                        onMouseEnter={(e) => {
                          let text: string | null = null;
                          if (iconKind === "invalid" && invalidReason) {
                            text = invalidReason;
                          } else if (
                            isLinked &&
                            partnerId !== undefined &&
                            pendingLinkTxnId === null
                          ) {
                            // Linked-row hover: surface the partner's
                            // basic facts so the user can identify which
                            // transaction this row is paired with even
                            // when the account/date filter hides the
                            // other side from the table.
                            const partner = txns.find(
                              (tt) => tt.id === partnerId,
                            );
                            if (partner) {
                              const pa = accountById.get(partner.accountId);
                              const accLabelP = pa
                                ? `${pa.name || pa.accountNumber} · ${pa.currency}`
                                : `#${partner.accountId}`;
                              const dateP = formatInstantLocal(
                                partner.occurredAtUtc,
                              );
                              const isIncoming = partner.credit !== "0.00";
                              const amountP = isIncoming
                                ? formatMoney(partner.credit)
                                : formatMoney(partner.debit);
                              const typeLabel = isIncoming
                                ? t("transactions.tableCredit")
                                : t("transactions.tableDebit");
                              text = `${accLabelP}\n${dateP}\n${typeLabel}: ${amountP}`;
                            }
                          }
                          if (text !== null) {
                            const r = e.currentTarget.getBoundingClientRect();
                            setTooltip({
                              x: r.left + r.width / 2,
                              y: r.top,
                              text,
                            });
                          }
                        }}
                        onMouseLeave={() => setTooltip(null)}
                      >
                        {iconKind === "link" || isStartable ? (
                          <ChainIcon />
                        ) : iconKind === "invalid" ? (
                          <CrossIcon />
                        ) : (
                          ""
                        )}
                      </button>
                    </td>
                    <td className="col-delta num">
                      {(() => {
                        const delta = deltas.get(x.id);
                        if (!delta) return "";
                        const isCredit = x.credit !== "0.00";
                        // Default ("%") mode shows nothing on the debit side
                        // — the percentage on the incoming row alone is the
                        // canonical "how much we lost on this conversion".
                        if (deltaMode === "percent" && !isCredit) return "";
                        return (
                          <DeltaCell
                            delta={delta}
                            mode={deltaMode}
                            t={t}
                            onShowTooltip={(text, rect) =>
                              setTooltip({
                                x: rect.left + rect.width / 2,
                                y: rect.top,
                                text,
                              })
                            }
                            onHideTooltip={() => setTooltip(null)}
                          />
                        );
                      })()}
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
                          // Truncated-content tooltip: only fires when the
                          // input is wider than its visible width, so a
                          // short comment doesn't trigger a redundant
                          // popup. Hides as soon as the user focuses
                          // the input — they're actively typing and the
                          // popup would just overlap the field.
                          onMouseEnter={(e) => {
                            const el = e.currentTarget;
                            if (el === document.activeElement) return;
                            const text = el.value;
                            if (!text.trim()) return;
                            if (el.scrollWidth <= el.clientWidth) return;
                            const r = el.getBoundingClientRect();
                            setTooltip({
                              x: r.left + r.width / 2,
                              y: r.top,
                              text,
                            });
                          }}
                          onMouseLeave={() => setTooltip(null)}
                          onFocus={() => setTooltip(null)}
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
                      <TruncatedCell
                        className="col-peer"
                        text={
                          x.isCorrecting
                            ? t("transactions.correctingLabel")
                            : x.peer ?? ""
                        }
                        onShowTooltip={(text, rect) =>
                          setTooltip({
                            x: rect.left + rect.width / 2,
                            y: rect.top,
                            text,
                          })
                        }
                        onHideTooltip={() => setTooltip(null)}
                      />
                    )}
                    {showBankDescription && (
                      <TruncatedCell
                        className="col-bank-description"
                        text={x.bankDescription ?? ""}
                        onShowTooltip={(text, rect) =>
                          setTooltip({
                            x: rect.left + rect.width / 2,
                            y: rect.top,
                            text,
                          })
                        }
                        onHideTooltip={() => setTooltip(null)}
                      />
                    )}
                  </tr>,
                );
                return nodes;
              })
            )}
            {visibleTxns.length > 0 && (
              <tr className="txn-tail-spacer" aria-hidden="true">
                <td colSpan={visibleColCount}></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pendingLinkTxnId !== null && (
        <div className="txn-link-overlay">
          <span>{t("transactions.linkPickPartner")}</span>
          {canWithdrawToCash && (
            <button
              type="button"
              disabled={cashAccounts.length === 0}
              title={
                cashAccounts.length === 0
                  ? t("transactions.withdrawNoCashAccounts")
                  : undefined
              }
              onClick={() => setWithdrawModalOpen(true)}
            >
              {t("transactions.withdrawToCash")}
            </button>
          )}
          <button
            type="button"
            onClick={() => setPendingLinkTxnId(null)}
          >
            {t("common.cancel")}
          </button>
        </div>
      )}
      {linkError && (
        <div className="txn-link-overlay txn-link-overlay--error">
          <span>{linkError}</span>
        </div>
      )}
      {tooltip !== null &&
        createPortal(
          <div
            className="txn-link-portal-tooltip"
            style={{ left: tooltip.x, top: tooltip.y }}
            role="tooltip"
          >
            {tooltip.text}
          </div>,
          document.body,
        )}
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
      {withdrawModalOpen && pendingSourceTxn && pendingSourceAccount && (
        <WithdrawToCashModal
          source={pendingSourceTxn}
          sourceAccount={pendingSourceAccount}
          cashAccounts={cashAccounts}
          localizedError={localizedLinkError}
          onCancel={() => setWithdrawModalOpen(false)}
          onCreated={(result) => {
            // Splice the new cash transaction into the txns array in
            // chronological order so it lands next to its source rather
            // than at the very bottom of the table. The backend returns
            // `listTransactions` sorted by occurred_at_utc ASC with id
            // ASC as the implicit tiebreaker — replicate that here so a
            // freshly-created row of the same date as an existing one
            // settles after it (the new row always has the higher id).
            setTxns((prev) => {
              const next = [...prev, result.newTransaction];
              next.sort((a, b) => {
                const t = a.occurredAtUtc.localeCompare(b.occurredAtUtc);
                if (t !== 0) return t;
                return a.id - b.id;
              });
              return next;
            });
            setLinks((prev) => [...prev, result.link]);
            setWithdrawModalOpen(false);
            setPendingLinkTxnId(null);
            setLinkError(null);
          }}
        />
      )}
    </section>
  );
}

// Modal that turns an outgoing bank transaction into a paired cash credit:
// the user picks which cash account receives the funds, confirms (and
// optionally adjusts) the amount, and the backend creates the new cash
// transaction plus the link in a single round-trip. When the source and
// cash-account currencies differ, the amount is prefilled via the
// `convert_amount` Tauri command using the rate at the source's date — but
// the user remains free to override the value.
function WithdrawToCashModal({
  source,
  sourceAccount,
  cashAccounts,
  localizedError,
  onCancel,
  onCreated,
}: {
  source: Transaction;
  sourceAccount: Account;
  cashAccounts: Account[];
  localizedError: (code: string) => string;
  onCancel: () => void;
  onCreated: (result: { newTransaction: Transaction; link: TxnLink }) => void;
}) {
  const t = useT();
  const [cashAccountId, setCashAccountId] = useState<number | null>(
    cashAccounts[0]?.id ?? null,
  );
  const [amount, setAmount] = useState("");
  const [rateLoading, setRateLoading] = useState(false);
  const [rateUnavailable, setRateUnavailable] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedCashAccount = useMemo(
    () => cashAccounts.find((a) => a.id === cashAccountId) ?? null,
    [cashAccounts, cashAccountId],
  );

  // Prefill / refresh the amount whenever the selected cash account changes
  // (and on first open). Same-currency case skips the network round-trip
  // and just copies the source debit. Cross-currency falls back to the
  // backend FX converter; on missing rate we leave the field empty and
  // surface a hint so the user can type the value by hand.
  useEffect(() => {
    if (!selectedCashAccount) return;
    let cancelled = false;
    setErrorMessage(null);
    setRateUnavailable(false);

    if (selectedCashAccount.currency === sourceAccount.currency) {
      setAmount(source.debit);
      setRateLoading(false);
      return;
    }

    setRateLoading(true);
    const date = source.occurredAtUtc.slice(0, 10);
    convertAmount({
      amount: source.debit,
      fromCurrency: sourceAccount.currency,
      toCurrency: selectedCashAccount.currency,
      dateYyyyMmDd: date,
    })
      .then((converted) => {
        if (cancelled) return;
        setAmount(converted);
        setRateLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        // Stable code from the backend → leave the field empty and show a
        // localised hint. Any other error we surface as a generic message.
        const code = String(e);
        if (code.includes("withdrawal.rate_unavailable")) {
          setRateUnavailable(true);
          setAmount("");
        } else {
          setErrorMessage(localizedError(code));
          setAmount("");
        }
        setRateLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    selectedCashAccount,
    sourceAccount.currency,
    source.debit,
    source.occurredAtUtc,
    localizedError,
  ]);

  // Local Escape handler — the parent's pending-link cancel effect is paused
  // while we're open, so we own dismissal here. Submit stays on the form
  // button only.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  const amountMinor = parseMoneyToMinor(amount);
  const canSubmit =
    cashAccountId !== null &&
    !rateLoading &&
    !submitting &&
    amountMinor !== null &&
    amountMinor > 0;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || cashAccountId === null) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const result = await createCashWithdrawal({
        sourceTxnId: source.id,
        cashAccountId,
        amount,
      });
      onCreated(result);
    } catch (e) {
      setErrorMessage(localizedError(String(e)));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="txn-link-confirm-overlay withdraw-modal-backdrop"
      onClick={onCancel}
    >
      <form
        className="txn-link-confirm withdraw-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3>{t("transactions.withdrawModalTitle")}</h3>
        <label className="withdraw-modal-field">
          <span>{t("transactions.withdrawAccountLabel")}</span>
          <select
            value={cashAccountId ?? ""}
            disabled={cashAccounts.length === 0 || submitting}
            onChange={(e) => setCashAccountId(Number(e.target.value))}
          >
            {cashAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name || a.bank} · {a.currency}
              </option>
            ))}
          </select>
        </label>
        <label className="withdraw-modal-field">
          <span>
            {t("transactions.withdrawAmountLabel")}
            {selectedCashAccount ? ` · ${selectedCashAccount.currency}` : ""}
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            disabled={submitting}
            placeholder={rateLoading ? t("transactions.withdrawRateLoading") : ""}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
          {rateUnavailable && (
            <span className="withdraw-modal-hint">
              {t("transactions.withdrawRateUnavailable")}
            </span>
          )}
        </label>
        {errorMessage && (
          <p className="withdraw-modal-error">{errorMessage}</p>
        )}
        <div className="txn-link-confirm-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={onCancel}
            disabled={submitting}
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={!canSubmit}
          >
            {t("transactions.withdrawSubmit")}
          </button>
        </div>
      </form>
    </div>
  );
}

// Plain-text table cell with ellipsis truncation and a hover tooltip that
// reveals the full text. Only triggers when the rendered span is wider
// than its visible area — short content doesn't fire a redundant popup.
// Used for the Peer and Bank Description columns where the value is
// opaque text that can be long and wraps awkwardly.
function TruncatedCell({
  className,
  text,
  onShowTooltip,
  onHideTooltip,
}: {
  className: string;
  text: string;
  onShowTooltip: (text: string, rect: DOMRect) => void;
  onHideTooltip: () => void;
}) {
  return (
    <td
      className={className}
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        if (!text.trim()) return;
        if (el.scrollWidth <= el.clientWidth) return;
        onShowTooltip(text, el.getBoundingClientRect());
      }}
      onMouseLeave={onHideTooltip}
    >
      {text}
    </td>
  );
}

// Chain link glyph. Used everywhere the cell wants a 🔗 symbol — rendered
// as an SVG so CSS `color` actually changes its hue (the emoji 🔗 is
// rendered in fixed multi-colour by the OS and ignores text color).
function ChainIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
    </svg>
  );
}

// "Can't link" cross — used during pending mode for rows that are not
// valid partners. Bigger, bolder strokes than ChainIcon so the rejection
// reads instantly even at thumbnail size.
function CrossIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

/// Format a signed minor amount for the Δ column. Positive values get an
/// explicit "+" prefix so a quick visual scan distinguishes gains from the
/// losses that share the row with the Debit column. Zero is rendered as plain
/// "0.00" — no sign, no plus.
function formatSignedDeltaMinor(minor: number): string {
  if (minor === 0) return "0.00";
  const sign = minor > 0 ? "+" : "-";
  const abs = Math.abs(minor);
  const major = Math.trunc(abs / 100);
  const cents = abs % 100;
  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${grouped}.${cents.toString().padStart(2, "0")}`;
}

/// Signed percentage of the dictionary-fair amount, rounded to two decimals.
/// Returns null when the percentage can't be computed — defensively handles
/// `expectedMinor === 0`, which would only happen on a degenerate link with
/// a near-zero partner amount and isn't worth surfacing as a number.
function formatSignedPercent(
  deltaMinor: number,
  expectedMinor: number | null,
): string | null {
  if (expectedMinor === null || expectedMinor === 0) return null;
  const pct = (deltaMinor / expectedMinor) * 100;
  // Round to two decimals so the displayed value matches the comparison
  // we use for the zero case (avoid "+0.00%" when the underlying float is
  // 0.0001 — we want the neutral colour and no sign in that case).
  const rounded = Math.round(pct * 100) / 100;
  if (rounded === 0) return "0.00%";
  const sign = rounded > 0 ? "+" : "-";
  return `${sign}${Math.abs(rounded).toFixed(2)}%`;
}

/// Renders one Δ cell for a linked transaction. Encapsulates the two display
/// modes and the cross-mode tooltip composition so the table-row JSX stays
/// focused on layout. The caller decides whether to render this at all (in
/// "percent" mode the debit side of every pair is just an empty cell).
function DeltaCell({
  delta,
  mode,
  t,
  onShowTooltip,
  onHideTooltip,
}: {
  delta: TransferDelta;
  mode: DeltaMode;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onShowTooltip: (text: string, rect: DOMRect) => void;
  onHideTooltip: () => void;
}) {
  // Missing rate — same red bold dash regardless of mode. Tooltip explains.
  if (delta.deltaMinor === null) {
    const text = t("transactions.deltaNoRateTooltip");
    return (
      <span
        className="txn-delta is-missing"
        onMouseEnter={(e) =>
          onShowTooltip(text, e.currentTarget.getBoundingClientRect())
        }
        onMouseLeave={onHideTooltip}
      >
        —
      </span>
    );
  }

  const polarityCls =
    delta.deltaMinor > 0
      ? "is-pos"
      : delta.deltaMinor < 0
      ? "is-neg"
      : "is-zero";

  // Pre-compute both representations: the active mode goes into the cell,
  // the other one rides along in the tooltip so the user can see what the
  // alternative mode would show without flipping the toggle.
  const absText = formatSignedDeltaMinor(delta.deltaMinor);
  const pctText = formatSignedPercent(delta.deltaMinor, delta.expectedMinor);

  const primary = mode === "percent" ? pctText : absText;
  const alternate =
    mode === "percent" ? `${absText} ${delta.currency}` : pctText;

  const lines: string[] = [];
  if (delta.rateDate !== null) {
    lines.push(t("transactions.deltaRateDateTooltip", { date: delta.rateDate }));
  }
  if (alternate !== null && alternate !== "") {
    lines.push(alternate);
  }
  const tooltip = lines.join("\n");

  return (
    <span
      className={`txn-delta ${polarityCls}`}
      onMouseEnter={(e) =>
        onShowTooltip(tooltip, e.currentTarget.getBoundingClientRect())
      }
      onMouseLeave={onHideTooltip}
    >
      {primary ?? ""}
    </span>
  );
}

function buildAccountTooltip(
  acc: Account,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const lines: string[] = [];
  if (acc.name) lines.push(`${t("accounts.fieldName")}: ${acc.name}`);
  if (acc.bank) lines.push(`${t("accounts.fieldBank")}: ${acc.bank}`);
  lines.push(`${t("accounts.fieldCurrency")}: ${acc.currency}`);
  if (acc.accountNumber)
    lines.push(`${t("accounts.fieldAccountNumber")}: ${acc.accountNumber}`);
  if (acc.ownerName)
    lines.push(`${t("accounts.fieldOwner")}: ${acc.ownerName}`);
  return lines.join("\n");
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
