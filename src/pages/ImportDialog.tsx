import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useT, useTPlural } from "../i18n";
import {
  Account,
  ImportResult,
  TxnImportRow,
  importTransactions,
  listAccounts,
} from "../lib/api";
import { parseTransactionsCsv } from "../lib/csv";

interface Props {
  initialAccountId?: number | null;
  onClose: () => void;
  onImported: () => void;
}

type Step = 1 | 2;

const OFFSET_OPTIONS = buildOffsetOptions();

export function ImportDialog({
  initialAccountId,
  onClose,
  onImported,
}: Props) {
  const t = useT();
  const tPlural = useTPlural();

  const [step, setStep] = useState<Step>(1);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<number | null>(
    initialAccountId ?? null,
  );
  const [defaultOffset, setDefaultOffset] = useState<string>(systemOffset());
  const [filename, setFilename] = useState<string | null>(null);
  const [rawText, setRawText] = useState<string>(() => t("import.pasteExample"));
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAccounts()
      .then((list) => {
        setAccounts(list);
        if (accountId === null && list.length > 0) {
          setAccountId(list[0].id);
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  const parsed = useMemo(() => {
    if (!rawText.trim()) {
      return { rows: [] as TxnImportRow[], errors: [] as string[] };
    }
    return parseTransactionsCsv(rawText, t);
  }, [rawText, t]);

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setError(null);
    setFilename(file.name);
    file.text().then(setRawText).catch((err) => setError(String(err)));
  }

  function onPasteChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setResult(null);
    setError(null);
    setFilename(null);
    setRawText(e.target.value);
  }

  async function onConfirm() {
    if (accountId === null || parsed.rows.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await importTransactions({
        accountId,
        sourceFilename: filename,
        defaultTimezoneOffset: defaultOffset,
        rows: parsed.rows,
      });
      setResult(res);
      onImported();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const canGoNext =
    accountId !== null &&
    parsed.rows.length > 0 &&
    parsed.errors.length === 0;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
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
          {step === 1 && (
            <>
              <div className="import-fields">
                <label className="import-field">
                  <span>{t("import.account")}</span>
                  <select
                    value={accountId ?? ""}
                    onChange={(e) => setAccountId(Number(e.target.value))}
                    disabled={accounts.length === 0}
                  >
                    {accounts.length === 0 ? (
                      <option value="">{t("import.noAccounts")}</option>
                    ) : (
                      accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name || a.accountNumber || `#${a.id}`} —{" "}
                          {a.bank} · {a.currency}
                        </option>
                      ))
                    )}
                  </select>
                </label>

                <label className="import-field">
                  <span>{t("import.defaultOffset")}</span>
                  <select
                    value={defaultOffset}
                    onChange={(e) => setDefaultOffset(e.target.value)}
                  >
                    {OFFSET_OPTIONS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <p className="hint">{t("import.hintColumns")}</p>

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

              <p className="import-or">{t("import.orPasteHere")}</p>

              <textarea
                className="import-paste"
                rows={10}
                value={rawText}
                placeholder={t("import.pastePlaceholder")}
                onChange={onPasteChange}
              />

              {parsed.errors.length > 0 && (
                <div className="errors-block">
                  <strong>{t("import.parseErrorsTitle")}</strong>
                  <ul>
                    {parsed.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}

              {error && <div className="error">{error}</div>}
            </>
          )}

          {step === 2 && !result && (
            <>
              <p>
                <strong>{t("import.previewLabel")}</strong>{" "}
                {tPlural("import.previewRows", parsed.rows.length)}
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
                    {parsed.rows.map((r, i) => (
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
              </div>
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
          {result ? (
            <button type="button" className="btn-primary" onClick={onClose}>
              {t("import.doneButton")}
            </button>
          ) : step === 1 ? (
            <>
              <button type="button" className="btn-ghost" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!canGoNext}
                onClick={() => setStep(2)}
              >
                {t("import.next")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setStep(1)}
                disabled={submitting}
              >
                {t("import.back")}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={submitting || parsed.rows.length === 0}
                onClick={onConfirm}
              >
                {submitting ? t("import.submitting") : t("import.submit")}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function buildOffsetOptions(): string[] {
  const offsets = [
    "-12:00", "-11:00", "-10:00", "-09:30", "-09:00", "-08:00", "-07:00",
    "-06:00", "-05:00", "-04:00", "-03:30", "-03:00", "-02:00", "-01:00",
    "+00:00", "+01:00", "+02:00", "+03:00", "+03:30", "+04:00", "+04:30",
    "+05:00", "+05:30", "+05:45", "+06:00", "+06:30", "+07:00", "+08:00",
    "+08:45", "+09:00", "+09:30", "+10:00", "+10:30", "+11:00", "+12:00",
    "+12:45", "+13:00", "+14:00",
  ];
  return offsets;
}

function systemOffset(): string {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const formatted = `${sign}${hh}:${mm}`;
  return OFFSET_OPTIONS.includes(formatted) ? formatted : "+00:00";
}
