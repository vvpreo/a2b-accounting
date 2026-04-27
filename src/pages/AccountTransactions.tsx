import { useEffect, useState } from "react";

import {
  Account,
  ImportBatch,
  Transaction,
  ValidationError,
  deleteImportBatch,
  listAccounts,
  listImportBatches,
  listTransactions,
  validateBalanceChain,
} from "../lib/api";
import { ImportDialog } from "./ImportDialog";

interface Props {
  accountId: number;
  onBack: () => void;
}

export function AccountTransactionsPage({ accountId, onBack }: Props) {
  const [account, setAccount] = useState<Account | null>(null);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>(
    [],
  );
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingBatchId, setConfirmingBatchId] = useState<number | null>(null);
  const [deletingBatchId, setDeletingBatchId] = useState<number | null>(null);

  async function refresh() {
    try {
      const [accounts, t, b, v] = await Promise.all([
        listAccounts(),
        listTransactions(accountId),
        listImportBatches(accountId),
        validateBalanceChain(accountId),
      ]);
      setAccount(accounts.find((a) => a.id === accountId) ?? null);
      setTxns(t);
      setBatches(b);
      setValidationErrors(v);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, [accountId]);

  async function onConfirmDeleteBatch(batch: ImportBatch) {
    setDeletingBatchId(batch.id);
    try {
      await deleteImportBatch(batch.id);
      setConfirmingBatchId(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeletingBatchId(null);
    }
  }

  const invalidTxnIds = new Set(validationErrors.map((e) => e.txnId));

  return (
    <section className="page">
      <div className="page-toolbar">
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← К счетам
        </button>
        <h2>
          {account
            ? `${account.name} — ${account.bank} · ${account.accountNumber} (${account.currency})`
            : `Счёт #${accountId}`}
        </h2>
        <button
          type="button"
          className="btn-primary"
          onClick={() => setImporting(true)}
        >
          Импорт транзакций
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {validationErrors.length > 0 && (
        <div className="validation-warning">
          В цепочке балансов {validationErrors.length}{" "}
          {validationErrors.length === 1 ? "разрыв" : "разрывов"} — подсвечены
          красным ниже.
        </div>
      )}

      <div className="account-layout">
        <div className="txns-wrap">
          <table>
            <thead>
              <tr>
                <th>Дата (UTC)</th>
                <th>Контрагент</th>
                <th className="num">Поступление</th>
                <th className="num">Списание</th>
                <th className="num">Баланс</th>
                <th>Описание</th>
              </tr>
            </thead>
            <tbody>
              {txns.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty">
                    Транзакций пока нет. Нажмите «Импорт транзакций».
                  </td>
                </tr>
              ) : (
                txns.map((t) => (
                  <tr key={t.id} className={invalidTxnIds.has(t.id) ? "invalid" : ""}>
                    <td>{formatInstant(t.occurredAtUtc)}</td>
                    <td>{t.peer}</td>
                    <td className="num">{t.credit !== "0.00" ? t.credit : ""}</td>
                    <td className="num">{t.debit !== "0.00" ? t.debit : ""}</td>
                    <td className="num">{t.balance}</td>
                    <td>{t.description}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <aside className="batches-panel">
          <h3>Загрузки</h3>
          {batches.length === 0 ? (
            <p className="empty">Пока ничего не загружено.</p>
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
                      {b.rowCount} {b.rowCount === 1 ? "строка" : "строк"} · TZ {b.timezoneOffset || "—"}
                    </div>
                    {!confirming ? (
                      <button
                        type="button"
                        className="btn-danger-ghost"
                        onClick={() => setConfirmingBatchId(b.id)}
                      >
                        Удалить
                      </button>
                    ) : (
                      <div className="delete-confirm">
                        Удалить загрузку? Все её транзакции пропадут.
                        <div className="delete-confirm-actions">
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => setConfirmingBatchId(null)}
                            disabled={deleting}
                          >
                            Отмена
                          </button>
                          <button
                            type="button"
                            className="btn-danger"
                            onClick={() => onConfirmDeleteBatch(b)}
                            disabled={deleting}
                          >
                            {deleting ? "Удаляю..." : "Да, удалить"}
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

      {importing && (
        <ImportDialog
          accountId={accountId}
          onClose={() => setImporting(false)}
          onImported={refresh}
        />
      )}
    </section>
  );
}

function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 19).replace("T", " ");
}
