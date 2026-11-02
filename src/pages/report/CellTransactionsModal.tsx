import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import {
  Category,
  CategoryKind,
  CellTransaction,
  ReportRequest,
  TransactionCategoryView,
  listTransactionsCategories,
  reportCellTransactions,
  setTransactionCategories,
} from "../../lib/api";
import { formatMinorAsMoney, parseMoneyToMinor } from "../../lib/money";
import { CategoryDistributionModal } from "../../components/CategoryDistributionModal";
import { CategoryPickerPopover } from "../../components/CategoryPickerPopover";
import { TransactionModal } from "../../components/TransactionModal";
import type { CellClickInfo } from "../ReportView";
import {
  CellSort,
  CellSortKey,
  DEFAULT_CELL_SORT,
  nextCellSort,
  sortCellTransactions,
} from "./cell-txns-sort";

interface CellTransactionsModalProps {
  request: ReportRequest;
  info: CellClickInfo;
  // id → display label for the account column.
  accountNameById: Map<number, string>;
  onClose: () => void;
  // Called after any edit made from this modal, so the report recomputes.
  onChanged: () => void;
}

// Render an ISO instant as local "YYYY-MM-DD HH:MM" — same shape as the
// Transactions tab, so dates read identically across screens.
function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${mi}`;
}

/**
 * Drill-down for a single report cell. Fetches the transactions that rolled
 * into the clicked cell (same scope/exclusion/attribution as the report) and
 * lists them with the share attributed to this category. The footer total
 * equals the clicked cell value.
 *
 * Categories are edited right in the list, the way the Transactions screen
 * does it: a click on the categories picks one category for the whole amount,
 * ✎ opens the split editor. Edits stay pending (highlighted) until the
 * explicit Save; then the list is re-fetched and the report recomputes.
 */
export function CellTransactionsModal({
  request,
  info,
  accountNameById,
  onClose,
  onChanged,
}: CellTransactionsModalProps) {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<CellTransaction[] | null>(null);
  const [sort, setSort] = useState<CellSort>(DEFAULT_CELL_SORT);
  const sortedRows = useMemo(
    () => sortCellTransactions(rows ?? [], sort, locale),
    [rows, sort, locale],
  );
  const [error, setError] = useState<string | null>(null);
  // The clicked transaction whose view/edit modal is open, if any.
  const [detailTxnId, setDetailTxnId] = useState<number | null>(null);
  // Category shares of the listed transactions as saved, by transaction id.
  const [catsByTxn, setCatsByTxn] = useState<Map<number, TransactionCategoryView[]>>(new Map());
  // Unsaved category edits, by transaction id (an empty list clears them).
  const [pending, setPending] = useState<Map<number, TransactionCategoryView[]>>(new Map());
  const [picker, setPicker] = useState<{ row: CellTransaction; rect: DOMRect } | null>(null);
  const [splitRow, setSplitRow] = useState<CellTransaction | null>(null);
  const [saving, setSaving] = useState(false);
  // Set when the user tries to close with unsaved edits.
  const [closeWarning, setCloseWarning] = useState(false);
  // Bumped after a save to re-fetch this list.
  const [refresh, setRefresh] = useState(0);

  function sortableHeader(key: CellSortKey, label: string, className?: string) {
    const active = sort.key === key;
    return (
      <th
        className={className}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          type="button"
          className={`cell-txns-sort${active ? " is-active" : ""}`}
          onClick={() => setSort(nextCellSort(sort, key))}
        >
          {label}
          <span className="cell-txns-sort-mark" aria-hidden="true">
            {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
          </span>
        </button>
      </th>
    );
  }

  const hasPending = pending.size > 0;
  const nestedOpen = detailTxnId !== null || splitRow !== null || picker !== null;

  function requestClose() {
    if (hasPending) {
      setCloseWarning(true);
      return;
    }
    onClose();
  }

  // ESC closes the modal (only when nothing sits on top of it).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !nestedOpen) requestClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    reportCellTransactions(request, info.target)
      .then(async (r) => {
        const accountIds = [...new Set(r.map((x) => x.accountId))];
        const views = accountIds.length > 0 ? await listTransactionsCategories(accountIds) : [];
        const ids = new Set(r.map((x) => x.id));
        const byTxn = new Map<number, TransactionCategoryView[]>();
        for (const v of views) {
          if (!ids.has(v.transactionId)) continue;
          const list = byTxn.get(v.transactionId) ?? [];
          list.push(v);
          byTxn.set(v.transactionId, list);
        }
        for (const list of byTxn.values()) list.sort((a, b) => a.position - b.position);
        if (!cancelled) {
          setCatsByTxn(byTxn);
          setRows(r);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [request, info, refresh]);

  const total = useMemo(
    () => (rows ? rows.reduce((acc, r) => acc + r.shareMinor, 0) : 0),
    [rows],
  );

  const totalOf = (r: CellTransaction) =>
    (parseMoneyToMinor(r.credit) ?? 0) + (parseMoneyToMinor(r.debit) ?? 0);
  const kindOf = (r: CellTransaction): CategoryKind =>
    r.credit !== "0.00" ? "income" : "expense";
  const catsOf = (id: number) => pending.get(id) ?? catsByTxn.get(id) ?? [];

  // Stage an edit; an edit that brings the row back to its saved state is
  // dropped from the pending set.
  function stage(id: number, split: TransactionCategoryView[]) {
    const signature = (list: TransactionCategoryView[]) =>
      list.map((c) => `${c.categoryId}:${c.shareMinor}`).join(",");
    setPending((prev) => {
      const next = new Map(prev);
      if (signature(split) === signature(catsByTxn.get(id) ?? [])) next.delete(id);
      else next.set(id, split);
      return next;
    });
    setCloseWarning(false);
  }

  function pickOne(row: CellTransaction, c: Category) {
    setPicker(null);
    stage(row.id, [
      {
        transactionId: row.id,
        categoryId: c.id,
        shareMinor: totalOf(row),
        position: 0,
        categoryName: c.name,
        categoryColor: c.color,
        categoryKind: c.kind,
      },
    ]);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const left = new Map(pending);
    try {
      for (const [transactionId, split] of pending) {
        await setTransactionCategories({
          transactionId,
          items: split.map((c, position) => ({
            categoryId: c.categoryId,
            shareMinor: c.shareMinor,
            position,
          })),
        });
        left.delete(transactionId);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(left);
      setSaving(false);
      setCloseWarning(false);
      // Re-fetch the list (a recategorised row leaves the cell) and rebuild
      // the report behind the modal right away.
      setRefresh((v) => v + 1);
      onChanged();
    }
  }

  const sectionLabel =
    info.sectionKind === "income"
      ? t("report.sectionIncome")
      : t("report.sectionExpense");

  return (
    <>
      {createPortal(
        <div className="modal-backdrop" onClick={requestClose}>
          <div
            className="modal cell-txns-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <div className="cell-txns-title">
                <h3>
                  {info.categoryLabel} · {info.periodLabel}
                </h3>
                <span className="cell-txns-subtitle">{sectionLabel}</span>
              </div>
              <button
                className="icon-btn"
                onClick={requestClose}
                aria-label={t("common.close")}
                type="button"
              >
                ×
              </button>
            </header>

            <div className="modal-body cell-txns-body">
              {error && <div className="error">{error}</div>}
              {!error && rows === null && (
                <div className="report-loading">{t("report.loading")}</div>
              )}
              {!error && rows !== null && rows.length === 0 && (
                <div className="cell-txns-empty">
                  {t("report.cellTxns.empty")}
                </div>
              )}
              {rows !== null && rows.length > 0 && (
                <table className="cell-txns-table">
                  <thead>
                    <tr>
                      {sortableHeader("date", t("report.cellTxns.colDate"))}
                      <th>{t("report.cellTxns.colAccount")}</th>
                      {sortableHeader("amount", t("report.cellTxns.colAmount"), "cell-txns-amount")}
                      <th className="cell-txns-cats-col">{t("report.cellTxns.colCategories")}</th>
                      {sortableHeader("peer", t("report.cellTxns.colPeer"))}
                      <th>{t("report.cellTxns.colDescription")}</th>
                      <th>{t("report.cellTxns.colComment")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((r) => (
                      <tr
                        key={r.id}
                        className={pending.has(r.id) ? "cell-txns-row is-pending" : "cell-txns-row"}
                        onClick={() => setDetailTxnId(r.id)}
                      >
                        <td className="cell-txns-date">{formatLocal(r.occurredAtUtc)}</td>
                        <td className="cell-txns-ellipsis" title={accountNameById.get(r.accountId) ?? ""}>
                          {accountNameById.get(r.accountId) ?? `#${r.accountId}`}
                        </td>
                        <td className="cell-txns-amount">
                          {formatMinorAsMoney(r.shareMinor)}
                        </td>
                        <td className="cell-txns-cats" onClick={(e) => e.stopPropagation()}>
                          <div className="cell-txns-cats-inner">
                            <button
                              type="button"
                              className="cell-txns-cats-pick"
                              title={t("report.cellTxns.pickHint")}
                              onClick={(e) =>
                                setPicker({ row: r, rect: e.currentTarget.getBoundingClientRect() })
                              }
                            >
                              <CategoryChips
                                cats={catsOf(r.id)}
                                totalMinor={totalOf(r)}
                                uncategorizedLabel={t("report.uncategorized")}
                              />
                            </button>
                            <button
                              type="button"
                              className="cell-txns-cats-split"
                              title={t("report.cellTxns.splitHint")}
                              aria-label={t("report.cellTxns.splitHint")}
                              onClick={() => setSplitRow(r)}
                            >
                              ✎
                            </button>
                          </div>
                        </td>
                        <td className="cell-txns-ellipsis" title={r.peer ?? ""}>
                          {r.peer ?? ""}
                        </td>
                        <td
                          className="cell-txns-ellipsis"
                          title={r.bankDescription ?? ""}
                        >
                          {r.bankDescription ?? ""}
                        </td>
                        <td
                          className="cell-txns-ellipsis"
                          title={r.comment?.trim() || r.memo || ""}
                        >
                          {r.comment?.trim() || r.memo || ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <footer className="modal-footer cell-txns-footer">
              <span className="cell-txns-total">
                {t("report.cellTxns.total")}: {formatMinorAsMoney(total)}
              </span>
              {closeWarning && (
                <span className="cell-txns-warning">{t("report.cellTxns.unsaved")}</span>
              )}
              <div className="cell-txns-footer-actions">
                {hasPending && (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      setPending(new Map());
                      setCloseWarning(false);
                    }}
                    disabled={saving}
                  >
                    {t("report.cellTxns.discard")}
                  </button>
                )}
                <button
                  type="button"
                  className={hasPending ? "btn-ghost" : "btn-primary"}
                  onClick={requestClose}
                  disabled={saving}
                >
                  {t("common.close")}
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={save}
                  disabled={!hasPending || saving}
                >
                  {saving
                    ? t("common.saving")
                    : hasPending
                      ? t("report.cellTxns.saveCount", { count: pending.size })
                      : t("common.save")}
                </button>
              </div>
            </footer>

            {detailTxnId !== null && (
              <TransactionModal
                transactionId={detailTxnId}
                onClose={() => setDetailTxnId(null)}
                onChanged={() => {
                  setRefresh((v) => v + 1);
                  onChanged();
                }}
              />
            )}
          </div>
        </div>,
        document.body,
      )}

      {/* Outside the backdrop: clicks inside these must not reach it. */}
      {picker && (
        <CategoryPickerPopover
          kind={kindOf(picker.row)}
          excludeIds={[]}
          anchorRect={picker.rect}
          onPick={(c) => pickOne(picker.row, c)}
          onClear={() => {
            stage(picker.row.id, []);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}

      {splitRow !== null && (
        <CategoryDistributionModal
          transactionId={splitRow.id}
          totalMinor={totalOf(splitRow)}
          kind={kindOf(splitRow)}
          initial={catsOf(splitRow.id)}
          onClose={() => setSplitRow(null)}
          onSaved={() => setSplitRow(null)}
          onApply={(split) => {
            stage(splitRow.id, split);
            setSplitRow(null);
          }}
        />
      )}
    </>
  );
}

// Compact category list for one row: a dot + name per category, plus the
// uncategorized remainder (total − Σ shares), the same way the report counts it.
function CategoryChips({
  cats,
  totalMinor,
  uncategorizedLabel,
}: {
  cats: TransactionCategoryView[];
  totalMinor: number;
  uncategorizedLabel: string;
}) {
  const allocated = cats.reduce((acc, c) => acc + c.shareMinor, 0);
  const rest = Math.max(0, totalMinor - allocated);
  const split = cats.length + (rest > 0 ? 1 : 0) > 1;
  return (
    <span className="cell-txns-chips">
      {cats.map((c) => (
        <span
          key={c.categoryId}
          className="cell-txns-chip"
          title={split ? `${c.categoryName}: ${formatMinorAsMoney(c.shareMinor)}` : c.categoryName}
        >
          <span className="cell-txns-chip-dot" style={{ background: c.categoryColor }} />
          {c.categoryName}
        </span>
      ))}
      {rest > 0 && (
        <span className="cell-txns-chip cell-txns-chip--uncat">
          {uncategorizedLabel}
          {split && ` ${formatMinorAsMoney(rest)}`}
        </span>
      )}
    </span>
  );
}
