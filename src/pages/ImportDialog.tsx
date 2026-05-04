import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useT, useTPlural } from "../i18n";
import {
  ACCOUNT_PRESETS,
  AccountPreset,
  ImportFormat,
  findPresetByName,
} from "../lib/account-presets";
import {
  Account,
  ImportResult,
  PreviewRowIssue,
  PreviewRowIssueKind,
  TxnImportRow,
  importTransactions,
  listAccounts,
  validateImportPreview,
} from "../lib/api";
import { DEFAULT_FORMAT_ID, parseByFormat } from "../lib/import-formats";
import { formatMoney } from "../lib/money";

type IssueFilter = "all" | PreviewRowIssueKind;
const ISSUE_KINDS: PreviewRowIssueKind[] = [
  "duplicate_db",
  "duplicate_file",
  "balance_db",
  "balance_file",
];

function isDuplicate(kind: PreviewRowIssueKind): boolean {
  return kind === "duplicate_db" || kind === "duplicate_file";
}

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
  const [formatId, setFormatId] = useState<string>(DEFAULT_FORMAT_ID);
  const [formatTouched, setFormatTouched] = useState(false);
  const [offsetTouched, setOffsetTouched] = useState(false);
  const [filename, setFilename] = useState<string | null>(null);
  const [rawText, setRawText] = useState<string>(() => t("import.pasteExample"));
  const [submitting, setSubmitting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewIssues, setPreviewIssues] = useState<PreviewRowIssue[]>([]);
  const [issueFilter, setIssueFilter] = useState<IssueFilter>("all");

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

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === accountId) ?? null,
    [accounts, accountId],
  );

  const selectedPreset: AccountPreset | null = useMemo(() => {
    if (!selectedAccount) return null;
    return findPresetByName(selectedAccount.bank) ?? null;
  }, [selectedAccount]);

  const availableFormats: ImportFormat[] = useMemo(() => {
    if (selectedPreset) return selectedPreset.supportedFormats;
    return ACCOUNT_PRESETS[0].supportedFormats;
  }, [selectedPreset]);

  // When the user picks a different account, follow that preset's defaults
  // (preferred format + bank's local timezone) — but only until the user
  // overrides them manually. After that we keep their explicit choice.
  useEffect(() => {
    if (!selectedPreset) return;
    if (!formatTouched) {
      const preferred = selectedPreset.supportedFormats[0]?.id;
      if (preferred && preferred !== formatId) setFormatId(preferred);
    }
    if (!offsetTouched && selectedPreset.defaultTimezoneOffset) {
      setDefaultOffset(selectedPreset.defaultTimezoneOffset);
    }
  }, [selectedPreset, formatTouched, offsetTouched]);

  // If the current format isn't actually supported by the chosen preset
  // (stale state after switching accounts), fall back to the preset's first
  // format. Doesn't count as a manual override.
  useEffect(() => {
    if (availableFormats.length === 0) return;
    if (!availableFormats.some((f) => f.id === formatId)) {
      setFormatId(availableFormats[0].id);
    }
  }, [availableFormats, formatId]);

  const parsed = useMemo(() => {
    if (!rawText.trim()) {
      return { rows: [] as TxnImportRow[], errors: [] as string[] };
    }
    return parseByFormat(formatId, rawText, t);
  }, [rawText, t, formatId]);

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

  const issuesByRow = useMemo(() => {
    const map = new Map<number, PreviewRowIssue[]>();
    for (const issue of previewIssues) {
      const arr = map.get(issue.rowIndex);
      if (arr) arr.push(issue);
      else map.set(issue.rowIndex, [issue]);
    }
    return map;
  }, [previewIssues]);

  const issueCounts = useMemo(() => {
    const counts: Record<PreviewRowIssueKind, Set<number>> = {
      balance_db: new Set(),
      balance_file: new Set(),
      duplicate_db: new Set(),
      duplicate_file: new Set(),
    };
    for (const i of previewIssues) {
      counts[i.kind].add(i.rowIndex);
    }
    return {
      balance_db: counts.balance_db.size,
      balance_file: counts.balance_file.size,
      duplicate_db: counts.duplicate_db.size,
      duplicate_file: counts.duplicate_file.size,
    };
  }, [previewIssues]);

  const skipRowIndices = useMemo(() => {
    const skip = new Set<number>();
    for (const issue of previewIssues) {
      if (isDuplicate(issue.kind)) skip.add(issue.rowIndex);
    }
    return skip;
  }, [previewIssues]);

  const visibleRows = useMemo(() => {
    return parsed.rows
      .map((row, idx) => ({ row, idx }))
      .filter(({ idx }) => {
        if (issueFilter === "all") return true;
        const rowIssues = issuesByRow.get(idx);
        return !!rowIssues && rowIssues.some((x) => x.kind === issueFilter);
      });
  }, [parsed.rows, issuesByRow, issueFilter]);

  async function goToPreview() {
    if (accountId === null || parsed.rows.length === 0) return;
    setValidating(true);
    setError(null);
    try {
      const validation = await validateImportPreview({
        accountId,
        defaultTimezoneOffset: defaultOffset,
        rows: parsed.rows,
      });
      setPreviewIssues(validation.rowIssues);
      setIssueFilter("all");
      setStep(2);
    } catch (e) {
      setError(String(e));
    } finally {
      setValidating(false);
    }
  }

  function backToStepOne() {
    setStep(1);
    setPreviewIssues([]);
    setIssueFilter("all");
  }

  async function onConfirm() {
    if (accountId === null || parsed.rows.length === 0) return;
    const goodRows = parsed.rows.filter((_, idx) => !skipRowIndices.has(idx));
    if (goodRows.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await importTransactions({
        accountId,
        sourceFilename: filename,
        defaultTimezoneOffset: defaultOffset,
        rows: goodRows,
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
    parsed.errors.length === 0 &&
    !validating;
  const importableCount = parsed.rows.length - skipRowIndices.size;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>
            {t("import.title")}
            {step === 2 && !result && parsed.rows.length > 0 && (
              <>
                {" "}
                {tPlural("import.titlePreviewSuffix", parsed.rows.length)}
              </>
            )}
          </h3>
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
                    onChange={(e) => {
                      setOffsetTouched(true);
                      setDefaultOffset(e.target.value);
                    }}
                  >
                    {OFFSET_OPTIONS.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>

                {availableFormats.length > 1 && (
                  <label className="import-field">
                    <span>{t("import.format")}</span>
                    <select
                      value={formatId}
                      onChange={(e) => {
                        setFormatTouched(true);
                        setFormatId(e.target.value);
                      }}
                    >
                      {availableFormats.map((f) => (
                        <option key={f.id} value={f.id}>
                          {formatLabel(f, t)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <p className="hint">
                {formatId === "kasikorn-csv-v1"
                  ? t("import.hintKasikorn")
                  : t("import.hintColumns")}
              </p>

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
              <div className="account-chips issue-filter-chips">
                <button
                  type="button"
                  className={`chip${issueFilter === "all" ? " active" : ""}`}
                  onClick={() => setIssueFilter("all")}
                >
                  {t("import.filterAll")} ({parsed.rows.length})
                </button>
                {ISSUE_KINDS.map((kind) =>
                  issueCounts[kind] > 0 ? (
                    <button
                      key={kind}
                      type="button"
                      className={`chip${issueFilter === kind ? " active" : ""}`}
                      onClick={() => setIssueFilter(kind)}
                    >
                      {t(`import.filter.${kind}`)} ({issueCounts[kind]})
                    </button>
                  ) : null,
                )}
              </div>
              {skipRowIndices.size > 0 && (
                <p className="hint">
                  {tPlural("import.skipNotice", skipRowIndices.size)}
                </p>
              )}
              <div className="preview-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t("import.previewDate")}</th>
                      <th className="num">{t("import.previewCredit")}</th>
                      <th className="num">{t("import.previewDebit")}</th>
                      <th className="num">{t("import.previewBalance")}</th>
                      <th>{t("import.previewPeer")}</th>
                      <th>{t("import.previewBankDescription")}</th>
                      <th>{t("import.previewComment")}</th>
                      <th>{t("import.previewIssues")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map(({ row, idx }) => {
                      const rowIssues = issuesByRow.get(idx);
                      const hasDup = rowIssues?.some((i) => isDuplicate(i.kind));
                      const hasIssue = !!rowIssues && rowIssues.length > 0;
                      const rowCls = hasDup
                        ? "invalid"
                        : hasIssue
                        ? "warning"
                        : "";
                      return (
                        <tr key={idx} className={rowCls}>
                          <td>{row.occurredAt}</td>
                          <td className="num">
                            {row.credit && row.credit !== "0.00" ? (
                              <span className="amount-credit">
                                {formatMoney(row.credit)}
                              </span>
                            ) : (
                              ""
                            )}
                          </td>
                          <td className="num">
                            {row.debit && row.debit !== "0.00" ? (
                              <span className="amount-debit">
                                {formatMoney(row.debit)}
                              </span>
                            ) : (
                              ""
                            )}
                          </td>
                          <td className="num">{formatMoney(row.balance)}</td>
                          <td>{row.peer ?? ""}</td>
                          <td>{row.bankDescription ?? ""}</td>
                          <td>{row.comment ?? ""}</td>
                          <td>
                            {rowIssues?.map((issue, i) => (
                              <div
                                key={i}
                                className={`row-issue${
                                  isDuplicate(issue.kind) ? " row-issue--error" : " row-issue--warn"
                                }`}
                              >
                                {issue.kind === "balance_db" ||
                                issue.kind === "balance_file"
                                  ? t(`import.issue.${issue.kind}`, {
                                      expected: formatMoney(
                                        issue.expectedBalance ?? "",
                                      ),
                                      actual: formatMoney(
                                        issue.actualBalance ?? "",
                                      ),
                                    })
                                  : t(`import.issue.${issue.kind}`)}
                              </div>
                            ))}
                          </td>
                        </tr>
                      );
                    })}
                    {visibleRows.length === 0 && (
                      <tr>
                        <td className="empty" colSpan={8}>
                          {t("import.previewFilterEmpty")}
                        </td>
                      </tr>
                    )}
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
              {result.correctionsInserted > 0 && (
                <p className="hint">
                  {t("import.resultCorrections", {
                    count: result.correctionsInserted,
                  })}
                </p>
              )}
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
                          description:
                            e.bankDescription || e.comment || "—",
                          expected: formatMoney(e.expectedBalance),
                          actual: formatMoney(e.actualBalance),
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
                onClick={goToPreview}
              >
                {validating ? t("import.validating") : t("import.next")}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn-ghost"
                onClick={backToStepOne}
                disabled={submitting}
              >
                {t("import.back")}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={submitting || importableCount === 0}
                onClick={onConfirm}
              >
                {submitting
                  ? t("import.submitting")
                  : tPlural("import.submitWithCount", importableCount)}
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

function formatLabel(
  f: ImportFormat,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  // Translations live under "import.formats.<id>"; fall back to the registry
  // name when a translation isn't defined yet.
  const key = `import.formats.${f.id}`;
  const localized = t(key);
  return localized === key ? f.name : localized;
}
