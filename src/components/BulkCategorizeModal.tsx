import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n, useT } from "../i18n";
import {
  Account,
  Category,
  CategoryKind,
  Transaction,
  TransactionCategoryView,
  setTransactionCategories,
} from "../lib/api";
import { CategoryPickerPopover } from "./CategoryPickerPopover";
import { formatMoney, parseMoneyToMinor } from "../lib/money";

interface Props {
  /// The target set — already narrowed to the selected, currently-visible
  /// transactions by the caller. The modal never operates on anything outside
  /// this list.
  transactions: Transaction[];
  categoriesByTxn: Map<number, TransactionCategoryView[]>;
  accountById: Map<number, Account>;
  onClose: () => void;
  /// Called after the run finishes and the user closes the modal. The caller
  /// refreshes categories and clears the selection here.
  onDone: () => void;
}

type Phase = "confirm" | "running" | "done";

/// How a transaction is treated by the bulk run, given the "reassign" toggle.
type Plan = "process" | "skip-existing" | "skip-zero";

interface Row {
  txn: Transaction;
  direction: CategoryKind;
  totalMinor: number;
  hasCategory: boolean;
}

export function BulkCategorizeModal({
  transactions,
  categoriesByTxn,
  accountById,
  onClose,
  onDone,
}: Props) {
  const t = useT();
  const { locale } = useI18n();

  const [phase, setPhase] = useState<Phase>("confirm");
  // When off, transactions that already carry a categorisation are left
  // untouched — only uncategorised ones get the new category. Turning it on is
  // the explicit opt-in to overwrite existing categorisation.
  const [reassign, setReassign] = useState(false);
  const [incomeCategory, setIncomeCategory] = useState<Category | null>(null);
  const [expenseCategory, setExpenseCategory] = useState<Category | null>(null);
  const [picker, setPicker] = useState<
    { kind: CategoryKind; anchorRect: DOMRect } | null
  >(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<{
    success: number;
    errors: number;
    skippedExisting: number;
    skippedZero: number;
  } | null>(null);

  const incomeBtnRef = useRef<HTMLButtonElement | null>(null);
  const expenseBtnRef = useRef<HTMLButtonElement | null>(null);

  // Precompute per-transaction direction / total / categorisation state.
  const rows = useMemo<Row[]>(
    () =>
      transactions.map((txn) => {
        const totalMinor =
          (parseMoneyToMinor(txn.credit) ?? 0) +
          (parseMoneyToMinor(txn.debit) ?? 0);
        const direction: CategoryKind =
          txn.credit !== "0.00" ? "income" : "expense";
        const hasCategory = (categoriesByTxn.get(txn.id)?.length ?? 0) > 0;
        return { txn, direction, totalMinor, hasCategory };
      }),
    [transactions, categoriesByTxn],
  );

  function planFor(row: Row): Plan {
    if (row.totalMinor <= 0) return "skip-zero";
    if (!reassign && row.hasCategory) return "skip-existing";
    return "process";
  }

  const processable = useMemo(
    () => rows.filter((r) => planFor(r) === "process"),
    // planFor depends on `reassign`; recompute when it flips.
    [rows, reassign],
  );
  const skippedExisting = useMemo(
    () => rows.filter((r) => planFor(r) === "skip-existing").length,
    [rows, reassign],
  );
  const skippedZero = useMemo(
    () => rows.filter((r) => planFor(r) === "skip-zero").length,
    [rows, reassign],
  );

  const needIncome = processable.some((r) => r.direction === "income");
  const needExpense = processable.some((r) => r.direction === "expense");
  const incomeCount = processable.filter((r) => r.direction === "income").length;
  const expenseCount = processable.filter(
    (r) => r.direction === "expense",
  ).length;

  const canApply =
    processable.length > 0 &&
    (!needIncome || incomeCategory !== null) &&
    (!needExpense || expenseCategory !== null);

  // Escape closes the modal in confirm/done phases (never mid-run).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (phase === "running") return;
      if (phase === "done") onDone();
      else onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onClose, onDone]);

  async function runBulk() {
    setPhase("running");
    setProgress({ done: 0, total: processable.length });
    let success = 0;
    let errors = 0;
    for (const row of processable) {
      const category =
        row.direction === "income" ? incomeCategory : expenseCategory;
      if (!category) {
        errors += 1;
        setProgress((p) => ({ ...p, done: p.done + 1 }));
        continue;
      }
      try {
        await setTransactionCategories({
          transactionId: row.txn.id,
          items: [
            { categoryId: category.id, shareMinor: row.totalMinor, position: 0 },
          ],
        });
        success += 1;
      } catch {
        errors += 1;
      }
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }
    setSummary({ success, errors, skippedExisting, skippedZero });
    setPhase("done");
  }

  function openPicker(kind: CategoryKind) {
    const btn = kind === "income" ? incomeBtnRef.current : expenseBtnRef.current;
    if (btn) setPicker({ kind, anchorRect: btn.getBoundingClientRect() });
  }

  function formatDate(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(locale);
  }

  function accountLabel(accountId: number): string {
    const acc = accountById.get(accountId);
    if (!acc) return `#${accountId}`;
    return `${acc.name || acc.accountNumber || `#${accountId}`} · ${acc.currency}`;
  }

  function currentCategoryLabel(txnId: number): string {
    const entries = categoriesByTxn.get(txnId);
    if (!entries || entries.length === 0) {
      return t("transactions.categories.cellEmpty");
    }
    return entries.map((e) => e.categoryName).join(", ");
  }

  const backdropClick = () => {
    if (phase === "running") return;
    if (phase === "done") onDone();
    else onClose();
  };

  return createPortal(
    <div className="modal-backdrop" onClick={backdropClick}>
      <div
        className="modal bulk-categorize-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3>{t("transactions.bulk.assignCategory")}</h3>
          {phase !== "running" && (
            <button
              type="button"
              className="btn-ghost"
              onClick={phase === "done" ? onDone : onClose}
              aria-label={t("common.close")}
            >
              ✕
            </button>
          )}
        </header>

        <div className="modal-body">
          {phase === "done" && summary ? (
            <div className="bulk-done">
              <p className="bulk-done-main">
                {t("transactions.bulk.doneProcessed", { count: summary.success })}
              </p>
              {summary.skippedExisting > 0 && (
                <p className="bulk-done-line">
                  {t("transactions.bulk.doneSkippedExisting", {
                    count: summary.skippedExisting,
                  })}
                </p>
              )}
              {summary.skippedZero > 0 && (
                <p className="bulk-done-line">
                  {t("transactions.bulk.doneSkippedZero", {
                    count: summary.skippedZero,
                  })}
                </p>
              )}
              {summary.errors > 0 && (
                <p className="bulk-done-line bulk-done-errors">
                  {t("transactions.bulk.doneErrors", { count: summary.errors })}
                </p>
              )}
            </div>
          ) : phase === "running" ? (
            <div className="bulk-progress">
              <p>
                {t("transactions.bulk.progress", {
                  done: progress.done,
                  total: progress.total,
                })}
              </p>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: `${
                      progress.total === 0
                        ? 100
                        : Math.round((progress.done / progress.total) * 100)
                    }%`,
                  }}
                />
              </div>
            </div>
          ) : (
            <>
              <p className="bulk-intro">
                {t("transactions.bulk.confirmIntro", {
                  count: transactions.length,
                })}
              </p>

              <label className="bulk-reassign">
                <input
                  type="checkbox"
                  checked={reassign}
                  onChange={(e) => setReassign(e.target.checked)}
                />
                <span>{t("transactions.bulk.reassignLabel")}</span>
              </label>

              <p className="bulk-counts">
                {t("transactions.bulk.counts", {
                  process: processable.length,
                  skipped: skippedExisting,
                })}
              </p>

              <div className="bulk-pickers">
                {needIncome && (
                  <div className="bulk-picker-field">
                    <span className="bulk-picker-label">
                      {t("transactions.bulk.pickerIncome", {
                        count: incomeCount,
                      })}
                    </span>
                    <button
                      ref={incomeBtnRef}
                      type="button"
                      className="btn-secondary bulk-picker-btn"
                      onClick={() => openPicker("income")}
                    >
                      {incomeCategory ? (
                        <>
                          <span
                            className="categories-swatch"
                            style={{ backgroundColor: incomeCategory.color }}
                            aria-hidden="true"
                          />
                          {incomeCategory.name}
                        </>
                      ) : (
                        t("transactions.bulk.pickCategory")
                      )}
                    </button>
                  </div>
                )}
                {needExpense && (
                  <div className="bulk-picker-field">
                    <span className="bulk-picker-label">
                      {t("transactions.bulk.pickerExpense", {
                        count: expenseCount,
                      })}
                    </span>
                    <button
                      ref={expenseBtnRef}
                      type="button"
                      className="btn-secondary bulk-picker-btn"
                      onClick={() => openPicker("expense")}
                    >
                      {expenseCategory ? (
                        <>
                          <span
                            className="categories-swatch"
                            style={{ backgroundColor: expenseCategory.color }}
                            aria-hidden="true"
                          />
                          {expenseCategory.name}
                        </>
                      ) : (
                        t("transactions.bulk.pickCategory")
                      )}
                    </button>
                  </div>
                )}
              </div>

              <div className="bulk-list">
                <table>
                  <thead>
                    <tr>
                      <th>{t("transactions.tableDate")}</th>
                      <th>{t("transactions.tableAccount")}</th>
                      <th className="num">{t("transactions.bulk.colAmount")}</th>
                      <th>{t("transactions.tableCategory")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const plan = planFor(r);
                      const skipped = plan !== "process";
                      return (
                        <tr
                          key={r.txn.id}
                          className={skipped ? "is-skipped" : ""}
                        >
                          <td>{formatDate(r.txn.occurredAtUtc)}</td>
                          <td>{accountLabel(r.txn.accountId)}</td>
                          <td className="num">
                            {r.direction === "income"
                              ? formatMoney(r.txn.credit)
                              : formatMoney(r.txn.debit)}
                          </td>
                          <td>{currentCategoryLabel(r.txn.id)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <footer className="modal-footer">
          {phase === "done" ? (
            <button type="button" className="btn-primary" onClick={onDone}>
              {t("common.close")}
            </button>
          ) : phase === "running" ? (
            <button type="button" className="btn-primary" disabled>
              {t("transactions.bulk.running")}
            </button>
          ) : (
            <>
              <button type="button" className="btn-secondary" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!canApply}
                onClick={runBulk}
              >
                {t("transactions.bulk.apply")}
              </button>
            </>
          )}
        </footer>
      </div>

      {picker && (
        <CategoryPickerPopover
          kind={picker.kind}
          excludeIds={[]}
          anchorRect={picker.anchorRect}
          onPick={(c) => {
            if (picker.kind === "income") setIncomeCategory(c);
            else setExpenseCategory(c);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>,
    document.body,
  );
}
