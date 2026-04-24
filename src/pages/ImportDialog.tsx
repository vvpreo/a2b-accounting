import { ChangeEvent, useState } from "react";

import {
  ImportResult,
  TxnImportRow,
  importTransactions,
} from "../lib/api";
import { parseTransactionsCsv } from "../lib/csv";

interface Props {
  accountId: number;
  onClose: () => void;
  onImported: () => void;
}

export function ImportDialog({ accountId, onClose, onImported }: Props) {
  const [filename, setFilename] = useState<string | null>(null);
  const [rows, setRows] = useState<TxnImportRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setError(null);
    setFilename(file.name);
    const text = await file.text();
    const parsed = parseTransactionsCsv(text);
    setRows(parsed.rows);
    setParseErrors(parsed.errors);
  }

  async function onConfirm() {
    if (rows.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await importTransactions({
        accountId,
        sourceFilename: filename,
        rows,
      });
      setResult(res);
      onImported();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Импорт транзакций</h3>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="Закрыть"
            type="button"
          >
            ×
          </button>
        </header>

        <div className="modal-body">
          {!result && (
            <>
              <label className="file-input-label">
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={onFileChange}
                />
                {filename ? `Выбран: ${filename}` : "Выбрать CSV-файл"}
              </label>
              <p className="hint">
                Ожидаемые колонки: <code>occurred_at, peer, credit, debit, balance, description</code>.
                Дата в формате ISO-8601 с offset (например, <code>2026-04-01T10:15:00+03:00</code>).
              </p>

              {parseErrors.length > 0 && (
                <div className="errors-block">
                  <strong>Проблемы при парсинге CSV:</strong>
                  <ul>
                    {parseErrors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}

              {rows.length > 0 && (
                <>
                  <p>
                    <strong>Предпросмотр:</strong> {rows.length}{" "}
                    {rows.length === 1 ? "строка" : "строк"}
                  </p>
                  <div className="preview-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Дата</th>
                          <th>Контрагент</th>
                          <th>Поступление</th>
                          <th>Списание</th>
                          <th>Баланс</th>
                          <th>Описание</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, 20).map((r, i) => (
                          <tr key={i}>
                            <td>{r.occurredAt}</td>
                            <td>{r.peer}</td>
                            <td>{r.credit}</td>
                            <td>{r.debit}</td>
                            <td>{r.balance}</td>
                            <td>{r.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {rows.length > 20 && (
                      <p className="hint">
                        …показаны первые 20 из {rows.length}
                      </p>
                    )}
                  </div>
                </>
              )}

              {error && <div className="error">{error}</div>}
            </>
          )}

          {result && (
            <>
              <p>
                Импортировано <strong>{result.inserted}</strong> строк. Батч #
                {result.batchId}.
              </p>
              {result.validationErrors.length > 0 ? (
                <div className="errors-block">
                  <strong>
                    Разрывы в цепочке балансов ({result.validationErrors.length}):
                  </strong>
                  <ul>
                    {result.validationErrors.map((e) => (
                      <li key={e.txnId}>
                        {e.occurredAtUtc} — «{e.description || "—"}»: ожидался
                        баланс <strong>{e.expectedBalance}</strong>, в данных{" "}
                        <strong>{e.actualBalance}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="ok">Цепочка балансов целостна.</p>
              )}
            </>
          )}
        </div>

        <footer className="modal-footer">
          {!result ? (
            <>
              <button type="button" className="btn-ghost" onClick={onClose}>
                Отмена
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={submitting || rows.length === 0}
                onClick={onConfirm}
              >
                {submitting ? "Импортирую..." : "Импортировать"}
              </button>
            </>
          ) : (
            <button type="button" className="btn-primary" onClick={onClose}>
              Готово
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
