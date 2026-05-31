import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import {
  Account,
  CashDirection,
  CategoryKind,
  Transaction,
  TransactionCategoryView,
  deleteCashTransaction,
  getTransaction,
  listAccounts,
  listTransactionsCategories,
  updateCashTransaction,
  updateTransactionFields,
} from "../lib/api";
import { formatMinorAsMoney, formatMoney, parseMoneyToMinor } from "../lib/money";
import { CategoryDistributionModal } from "./CategoryDistributionModal";

interface Props {
  transactionId: number;
  onClose: () => void;
  // Called after a successful save/delete so the caller can refresh its lists.
  onChanged?: () => void;
}

// ISO instant → value for an <input type="datetime-local"> (local wall time).
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

// datetime-local value (local wall time) → ISO UTC string for the backend.
function fromLocalInputValue(v: string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function formatInstantLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

/**
 * View + edit a single transaction. Opens from anywhere transactions are
 * listed. Editable fields depend on the owning account:
 *  - cash accounts: date, direction, amount, peer, comment (recomputes the
 *    running balance backend-side) plus delete;
 *  - bank/imported accounts: peer, bank description, comment only — amounts,
 *    date and balance are read-only to preserve the statement balance chain.
 * Categories are edited via the existing distribution modal.
 */
export function TransactionModal({ transactionId, onClose, onChanged }: Props) {
  const t = useT();

  const [txn, setTxn] = useState<Transaction | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [cats, setCats] = useState<TransactionCategoryView[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Editable form state — seeded from the loaded transaction.
  const [peer, setPeer] = useState("");
  const [bankDescription, setBankDescription] = useState("");
  const [comment, setComment] = useState("");
  const [dateLocal, setDateLocal] = useState("");
  const [direction, setDirection] = useState<CashDirection>("out");
  const [amount, setAmount] = useState("");

  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [catsModalOpen, setCatsModalOpen] = useState(false);

  const isCash = account?.kind === "cash";

  async function reload() {
    setError(null);
    const transaction = await getTransaction(transactionId);
    const [accs, tcs] = await Promise.all([
      listAccounts(),
      listTransactionsCategories([transaction.accountId]),
    ]);
    setTxn(transaction);
    setAccount(accs.find((a) => a.id === transaction.accountId) ?? null);
    setCats(tcs.filter((c) => c.transactionId === transactionId));
    // Seed the form from the freshly loaded row.
    setPeer(transaction.peer ?? "");
    setBankDescription(transaction.bankDescription ?? "");
    setComment(transaction.comment ?? "");
    setDateLocal(toLocalInputValue(transaction.occurredAtUtc));
    setDirection(transaction.credit !== "0.00" ? "in" : "out");
    setAmount(
      transaction.credit !== "0.00" ? transaction.credit : transaction.debit,
    );
  }

  useEffect(() => {
    let cancelled = false;
    reload().catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactionId]);

  // ESC closes the modal (only when no nested modal is open).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !catsModalOpen) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, catsModalOpen]);

  async function handleSave() {
    if (!txn) return;
    setSaving(true);
    setError(null);
    try {
      if (isCash) {
        await updateCashTransaction({
          id: txn.id,
          occurredAtUtc: fromLocalInputValue(dateLocal),
          direction,
          amount: amount.trim() === "" ? "0" : amount.trim(),
          peer: peer.trim() === "" ? null : peer.trim(),
          comment: comment.trim() === "" ? null : comment.trim(),
        });
      } else {
        await updateTransactionFields({
          id: txn.id,
          peer: peer.trim() === "" ? null : peer.trim(),
          bankDescription:
            bankDescription.trim() === "" ? null : bankDescription.trim(),
          comment: comment.trim() === "" ? null : comment.trim(),
        });
      }
      onChanged?.();
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!txn) return;
    setSaving(true);
    setError(null);
    try {
      await deleteCashTransaction(txn.id);
      onChanged?.();
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  const accountLabel = account
    ? `${account.name || account.accountNumber || `#${account.id}`} · ${account.currency}`
    : txn
    ? `#${txn.accountId}`
    : "";

  // Category breakdown summary (read-only chips). Uncategorized remainder is
  // computed the same way the report does: total − Σ shares.
  const totalMinor = txn
    ? (parseMoneyToMinor(txn.credit) ?? 0) + (parseMoneyToMinor(txn.debit) ?? 0)
    : 0;
  const allocated = cats.reduce((acc, c) => acc + c.shareMinor, 0);
  const uncategorized = Math.max(0, totalMinor - allocated);
  const kind: CategoryKind =
    txn && txn.credit !== "0.00" ? "income" : "expense";

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal txn-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <div className="txn-modal-title">
            <h3>{t("transaction.title")}</h3>
            {txn && (
              <span className="txn-modal-subtitle">
                {accountLabel}
                {txn.isCorrecting && (
                  <span className="txn-badge txn-badge--correcting">
                    {t("transaction.correcting")}
                  </span>
                )}
                {isCash && (
                  <span className="txn-badge txn-badge--cash">
                    {t("transaction.cashBadge")}
                  </span>
                )}
              </span>
            )}
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
            type="button"
          >
            ×
          </button>
        </header>

        <div className="modal-body txn-modal-body">
          {error && <div className="error">{error}</div>}
          {!txn && !error && (
            <div className="report-loading">{t("common.loading")}</div>
          )}

          {txn && (
            <>
              {/* Read-only facts for bank rows; editable money/date for cash. */}
              {isCash ? (
                <div className="txn-field-grid">
                  <label className="txn-field">
                    <span className="txn-field-label">
                      {t("transaction.fieldDate")}
                    </span>
                    <input
                      type="datetime-local"
                      value={dateLocal}
                      onChange={(e) => setDateLocal(e.target.value)}
                    />
                  </label>
                  <label className="txn-field">
                    <span className="txn-field-label">
                      {t("transaction.fieldDirection")}
                    </span>
                    <div className="txn-direction">
                      <button
                        type="button"
                        className={
                          direction === "in"
                            ? "txn-dir-btn txn-dir-btn--active"
                            : "txn-dir-btn"
                        }
                        onClick={() => setDirection("in")}
                      >
                        {t("transaction.directionIn")}
                      </button>
                      <button
                        type="button"
                        className={
                          direction === "out"
                            ? "txn-dir-btn txn-dir-btn--active"
                            : "txn-dir-btn"
                        }
                        onClick={() => setDirection("out")}
                      >
                        {t("transaction.directionOut")}
                      </button>
                    </div>
                  </label>
                  <label className="txn-field">
                    <span className="txn-field-label">
                      {t("transaction.fieldAmount")}
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </label>
                </div>
              ) : (
                <div className="txn-readonly-grid">
                  <div className="txn-readonly">
                    <span className="txn-field-label">
                      {t("transaction.fieldDate")}
                    </span>
                    <span title={txn.occurredAtUtc}>
                      {formatInstantLocal(txn.occurredAtUtc)}
                    </span>
                  </div>
                  <div className="txn-readonly">
                    <span className="txn-field-label">
                      {t("transaction.fieldCredit")}
                    </span>
                    <span className="amount-credit">
                      {txn.credit !== "0.00" ? formatMoney(txn.credit) : "—"}
                    </span>
                  </div>
                  <div className="txn-readonly">
                    <span className="txn-field-label">
                      {t("transaction.fieldDebit")}
                    </span>
                    <span className="amount-debit">
                      {txn.debit !== "0.00" ? formatMoney(txn.debit) : "—"}
                    </span>
                  </div>
                  <div className="txn-readonly">
                    <span className="txn-field-label">
                      {t("transaction.fieldBalance")}
                    </span>
                    <span>{formatMoney(txn.balance)}</span>
                  </div>
                </div>
              )}

              {/* Free-text fields — editable for every transaction. */}
              <label className="txn-field">
                <span className="txn-field-label">
                  {t("transaction.fieldPeer")}
                </span>
                <input
                  type="text"
                  value={peer}
                  onChange={(e) => setPeer(e.target.value)}
                  placeholder={t("transaction.peerPlaceholder")}
                />
              </label>

              {!isCash && (
                <label className="txn-field">
                  <span className="txn-field-label">
                    {t("transaction.fieldDescription")}
                  </span>
                  <input
                    type="text"
                    value={bankDescription}
                    onChange={(e) => setBankDescription(e.target.value)}
                  />
                </label>
              )}

              <label className="txn-field">
                <span className="txn-field-label">
                  {t("transaction.fieldComment")}
                </span>
                <textarea
                  rows={2}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder={t("transaction.commentPlaceholder")}
                />
              </label>

              {/* Category breakdown + edit launcher. */}
              <div className="txn-cats">
                <div className="txn-cats-header">
                  <span className="txn-field-label">
                    {t("transaction.categories")}
                  </span>
                  <button
                    type="button"
                    className="btn-ghost btn-small"
                    onClick={() => setCatsModalOpen(true)}
                  >
                    {t("transaction.editCategories")}
                  </button>
                </div>
                <div className="txn-cats-chips">
                  {cats.map((c) => (
                    <span
                      key={c.categoryId}
                      className="txn-cat-chip"
                      style={{ borderColor: c.categoryColor }}
                    >
                      <span
                        className="txn-cat-dot"
                        style={{ background: c.categoryColor }}
                      />
                      {c.categoryName}
                      <span className="txn-cat-amount">
                        {formatMinorAsMoney(c.shareMinor)}
                      </span>
                    </span>
                  ))}
                  {uncategorized > 0 && (
                    <span className="txn-cat-chip txn-cat-chip--uncat">
                      {t("report.uncategorized")}
                      <span className="txn-cat-amount">
                        {formatMinorAsMoney(uncategorized)}
                      </span>
                    </span>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <footer className="modal-footer txn-modal-footer">
          {isCash &&
            txn &&
            (confirmDelete ? (
              <span className="txn-delete-confirm">
                <span>{t("transaction.confirmDelete")}</span>
                <button
                  type="button"
                  className="btn-danger btn-small"
                  onClick={handleDelete}
                  disabled={saving}
                >
                  {t("common.delete")}
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-small"
                  onClick={() => setConfirmDelete(false)}
                  disabled={saving}
                >
                  {t("common.cancel")}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn-danger btn-small modal-footer-left"
                onClick={() => setConfirmDelete(true)}
                disabled={saving}
              >
                {t("common.delete")}
              </button>
            ))}
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            disabled={saving}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleSave}
            disabled={saving || !txn}
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </footer>

        {catsModalOpen && txn && (
          <CategoryDistributionModal
            transactionId={txn.id}
            totalMinor={totalMinor}
            kind={kind}
            initial={cats}
            onClose={() => setCatsModalOpen(false)}
            onSaved={() => {
              setCatsModalOpen(false);
              onChanged?.();
              void reload().catch((e) => setError(String(e)));
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
