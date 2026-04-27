import { ChangeEvent, useState } from "react";

import { useT, useTPlural } from "../i18n";
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
  const t = useT();
  const tPlural = useTPlural();
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
    const parsed = parseTransactionsCsv(text, t);
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
          <h3>{t("import.title")}</h3>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
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
                {filename
                  ? t("import.buttonChosen", { filename })
                  : t("import.buttonChooseFile")}
              </label>
              <p className="hint">{t("import.hintColumns")}</p>

              {parseErrors.length > 0 && (
                <div className="errors-block">
                  <strong>{t("import.parseErrorsTitle")}</strong>
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
                    <strong>{t("import.previewLabel")}</strong>{" "}
                    {tPlural("import.previewRows", rows.length)}
                  </p>
                  <div className="preview-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{t("import.previewDate")}</th>
                          <th>{t("import.previewPeer")}</th>
                          <th>{t("import.previewCredit")}</th>
                          <th>{t("import.previewDebit")}</th>
                          <th>{t("import.previewBalance")}</th>
                          <th>{t("import.previewDescription")}</th>
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
                        {t("import.previewMore", { total: rows.length })}
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
                {t("import.resultDone", {
                  inserted: result.inserted,
                  batchId: result.batchId,
                })}
              </p>
              {result.validationErrors.length > 0 ? (
                <div className="errors-block">
                  <strong>
                    {t("import.resultBreaksTitle", {
                      count: result.validationErrors.length,
                    })}
                  </strong>
                  <ul>
                    {result.validationErrors.map((e) => (
                      <li key={e.txnId}>
                        {t("import.resultBreakLine", {
                          date: e.occurredAtUtc,
                          description: e.description || "—",
                          expected: e.expectedBalance,
                          actual: e.actualBalance,
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="ok">{t("import.resultOk")}</p>
              )}
            </>
          )}
        </div>

        <footer className="modal-footer">
          {!result ? (
            <>
              <button type="button" className="btn-ghost" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={submitting || rows.length === 0}
                onClick={onConfirm}
              >
                {submitting ? t("import.submitting") : t("import.submit")}
              </button>
            </>
          ) : (
            <button type="button" className="btn-primary" onClick={onClose}>
              {t("import.doneButton")}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
