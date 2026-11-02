import { useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import { Account, Transaction, deleteCashTransactions } from "../lib/api";

interface Props {
  /// The selected, currently-visible transactions.
  transactions: Transaction[];
  accountById: Map<number, Account>;
  onClose: () => void;
  /// After deleting: rows, balances, links and categories changed.
  onDeleted: () => void;
}

/// Actions ▾ → Manual → "Delete cash transactions": cash accounts are kept by
/// hand, so their rows can be deleted; bank rows in the selection are never
/// touched. Asks for confirmation; a cash withdrawal's bank side stays,
/// unlinked.
export function BulkDeleteCashModal({ transactions, accountById, onClose, onDeleted }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cash = transactions.filter((x) => accountById.get(x.accountId)?.kind === "cash");
  const other = transactions.length - cash.length;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await deleteCashTransactions(cash.map((x) => x.id));
      onDeleted();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal modal--bulk-docs" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{t("transactions.bulkDeleteCash.title")}</h3>
          {!busy && (
            <button className="icon-btn" onClick={onClose} aria-label={t("common.close")} type="button">
              ×
            </button>
          )}
        </header>
        <div className="modal-body">
          {cash.length === 0 ? (
            <p className="hint">{t("transactions.bulkDeleteCash.none")}</p>
          ) : (
            <>
              <p>{t("transactions.bulkDeleteCash.intro", { count: cash.length })}</p>
              <p className="hint">{t("transactions.bulkDeleteCash.hint")}</p>
            </>
          )}
          {other > 0 && <p className="hint">{t("transactions.bulkDeleteCash.skipped", { count: other })}</p>}
          {error && <div className="error">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn-danger" onClick={run} disabled={busy || cash.length === 0}>
            {busy ? t("common.deleting") : t("transactions.bulkDeleteCash.confirm", { count: cash.length })}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
