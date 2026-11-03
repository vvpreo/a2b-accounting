import { ChangeEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n, useT } from "../i18n";
import {
  Account,
  Category,
  TelegramImportState,
  commitTelegramImport,
  deleteTelegramImport,
  getTelegramImportState,
  listCategories,
  listTransactions,
  setTelegramChannel,
} from "../lib/api";
import { parseMoneyToMinor } from "../lib/money";
import {
  Bucket,
  EditedMessage,
  ParsedExport,
  WizardRow,
  isInvalid,
  markDuplicates,
  parseTelegramExport,
  planImport,
  restorePending,
  sortExport,
  splitList,
} from "../lib/telegram-export";
import { UTC_OFFSETS, systemUtcOffset } from "../lib/utc-offsets";
import { CategoryPickerPopover } from "./CategoryPickerPopover";

interface Props {
  account: Account;
  onClose: () => void;
  /** Entries were created or rolled back. */
  onChanged: () => Promise<void>;
}

type Step = "file" | "review" | "summary";
type Tab = Bucket | "edited";

const BUCKETS: Bucket[] = ["review", "out", "in", "ignore"];

const ERROR_KEYS: Record<string, string> = {
  "telegram_import.already_imported": "accounts.cash.telegram.errorAlreadyImported",
  "telegram_import.empty_title": "accounts.cash.telegram.errorEmptyTitle",
};

/// A category belongs to one direction: changing it takes the category off.
function moved(r: WizardRow, bucket: Bucket): WizardRow {
  return { ...r, bucket, categoryId: bucket === r.bucket ? r.categoryId : null };
}

interface RowViewProps {
  row: WizardRow;
  categoryPath: string | null;
  categoryColor: string | undefined;
  removable: boolean;
  onUpdate: (key: number, patch: Partial<WizardRow>) => void;
  onMove: (key: number, bucket: Bucket) => void;
  onSplit: (key: number) => void;
  onRemove: (key: number) => void;
  onPickCategory: (key: number, rect: DOMRect) => void;
}

/// Memoised: the file can hold a thousand rows, and typing in one of them must
/// not render the others.
const RowView = memo(function RowView({
  row: r,
  categoryPath,
  categoryColor,
  removable,
  onUpdate,
  onMove,
  onSplit,
  onRemove,
  onPickCategory,
}: RowViewProps) {
  const t = useT();
  const invalid = isInvalid(r);
  const entry = r.bucket === "in" || r.bucket === "out";
  return (
    <tr>
      <td>
        <span className="telegram-when">
          <input
            type="date"
            value={r.date}
            className={invalid && !r.date ? "is-invalid" : undefined}
            aria-label={t("accounts.cash.colDate")}
            onChange={(e) => onUpdate(r.key, { date: e.target.value })}
          />
          <input
            type="time"
            step={1}
            value={r.time}
            className={invalid && !r.time ? "is-invalid" : undefined}
            aria-label={t("accounts.cash.telegram.colTime")}
            onChange={(e) => onUpdate(r.key, { time: e.target.value })}
          />
        </span>
      </td>
      <td>
        <input
          inputMode="decimal"
          className={`cash-dictation-amount${invalid && r.date && r.time ? " is-invalid" : ""}`}
          value={r.amount}
          aria-label={t("accounts.cash.colAmount")}
          onChange={(e) => onUpdate(r.key, { amount: e.target.value })}
        />
      </td>
      <td>
        <input
          value={r.comment}
          aria-label={t("accounts.cash.colComment")}
          onChange={(e) => onUpdate(r.key, { comment: e.target.value })}
        />
      </td>
      <td>
        {entry && (
          <button
            type="button"
            className="cash-dictation-category"
            onClick={(e) => onPickCategory(r.key, e.currentTarget.getBoundingClientRect())}
          >
            {categoryPath !== null ? (
              <>
                <span className="cash-dictation-dot" style={{ background: categoryColor ?? "#a1a1aa" }} />
                {categoryPath}
              </>
            ) : (
              <span className="cash-dictation-placeholder">{t("accounts.cash.dictation.noCategory")}</span>
            )}
          </button>
        )}
      </td>
      <td>
        <select
          value={r.bucket}
          aria-label={t("accounts.cash.telegram.colGroup")}
          onChange={(e) => onMove(r.key, e.target.value as Bucket)}
        >
          {BUCKETS.map((b) => (
            <option key={b} value={b}>
              {t(`accounts.cash.telegram.bucket.${b}`)}
            </option>
          ))}
        </select>
      </td>
      <td className="telegram-source">
        <div className="telegram-source-text">{r.text}</div>
        {(r.reasons.length > 0 || r.bucket === "review") && (
          <div className="telegram-source-marks">
            {r.reasons.map((reason) => (
              <span
                key={reason}
                className="cash-dictation-mark is-warn"
                title={
                  reason === "possibleDuplicate" && r.duplicateOf
                    ? t("accounts.cash.telegram.duplicateOf", r.duplicateOf)
                    : undefined
                }
              >
                {t(`accounts.cash.telegram.reason.${reason}`)}
              </span>
            ))}
            {r.bucket === "review" && (
              <button type="button" className="telegram-suggest" onClick={() => onMove(r.key, "ignore")}>
                {t("accounts.cash.telegram.bucket.ignore")}
              </button>
            )}
          </div>
        )}
      </td>
      <td className="cash-dictation-marks">
        <button type="button" className="btn-ghost" onClick={() => onSplit(r.key)} title={t("accounts.cash.telegram.splitHint")}>
          {t("accounts.cash.telegram.split")}
        </button>
        {removable && (
          <button type="button" className="icon-btn" onClick={() => onRemove(r.key)} aria-label={t("common.delete")}>
            ×
          </button>
        )}
      </td>
    </tr>
  );
});

/// Records → "Import from Telegram": the file is parsed and sorted here, the
/// owner checks every group and corrects what is wrong, and only then anything
/// is written. See docs/plans/telegram-cash-import.md.
export function TelegramImportModal({ account, onClose, onChanged }: Props) {
  const t = useT();
  const { locale } = useI18n();
  const [step, setStep] = useState<Step>("file");
  const [known, setKnown] = useState<TelegramImportState | null>(null);
  const [title, setTitle] = useState("");
  const [offset, setOffset] = useState(systemUtcOffset());
  const [parsed, setParsed] = useState<ParsedExport | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // The file's channel differs from the bound one until the owner says it was renamed.
  const [renameConfirmed, setRenameConfirmed] = useState(false);
  const [rows, setRows] = useState<WizardRow[]>([]);
  const [edited, setEdited] = useState<EditedMessage[]>([]);
  const [balanceMinor, setBalanceMinor] = useState(0);
  const [tab, setTab] = useState<Tab>("review");
  const [categories, setCategories] = useState<Category[]>([]);
  const [picker, setPicker] = useState<{ key: number; rect: DOMRect } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRollback, setConfirmingRollback] = useState<number | null>(null);
  // Corrections live only in this window: closing it takes a second click.
  const [closeArmed, setCloseArmed] = useState(false);
  // What the rows were built from: going back and forth keeps the corrections.
  const builtFor = useRef<string | null>(null);
  const nextKey = useRef(1_000_000);

  const showError = useCallback(
    (e: unknown) => {
      const message = String(e);
      setError(ERROR_KEYS[message] ? t(ERROR_KEYS[message]) : message);
    },
    [t],
  );

  const reloadKnown = useCallback(async () => {
    const state = await getTelegramImportState(account.id);
    setKnown(state);
    return state;
  }, [account.id]);

  useEffect(() => {
    reloadKnown()
      .then((state) => {
        if (state.channel) {
          setTitle(state.channel.title);
          setOffset(state.channel.timezoneOffset);
        }
      })
      .catch(showError);
    listCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, [reloadKnown, showError]);

  const pathOf = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]));
    return (id: number): string => {
      const names: string[] = [];
      let cur = byId.get(id);
      while (cur && names.length < 16) {
        names.unshift(cur.name);
        cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
      }
      return names.join(" / ");
    };
  }, [categories]);
  const systemIds = useMemo(() => categories.filter((c) => c.systemKey).map((c) => c.id), [categories]);
  const colorOf = useMemo(() => new Map(categories.map((c) => [c.id, c.color])), [categories]);

  const moneyFmt = useMemo(() => {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: account.currency });
    } catch {
      return null;
    }
  }, [locale, account.currency]);
  const money = (minor: number) => (moneyFmt ? moneyFmt.format(minor / 100) : `${(minor / 100).toFixed(2)} ${account.currency}`);

  const fileTitle = parsed?.title ?? null;
  const boundTitle = known?.channel?.title ?? null;
  const titleConflict = fileTitle !== null && boundTitle !== null && fileTitle !== boundTitle && !renameConfirmed;
  const boundElsewhere = fileTitle ? known?.otherChannels.find((c) => c.title === fileTitle) : undefined;

  const preview = useMemo(
    () => (parsed && known ? sortExport(parsed.messages, known.messages, known.pending, account.currency) : null),
    [parsed, known, account.currency],
  );

  async function pickFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setError(null);
    try {
      const next = parseTelegramExport(await Promise.all(files.map((f) => f.text())));
      setParsed(next);
      setFileName(files.map((f) => f.name).join(", "));
      setRenameConfirmed(false);
      builtFor.current = null;
      // The first file names the channel; later the bound name stays until the
      // owner answers the question about a different one.
      if (!known?.channel && next.title) setTitle(next.title);
    } catch (err) {
      showError(err);
    }
  }

  async function toReview() {
    // Without a file: only what was left for review earlier.
    if (!known || (!parsed && known.pending.length === 0)) return;
    setError(null);
    const buildKey = `${offset}|${known.messages.length}|${parsed ? "file" : "pending"}`;
    if (builtFor.current === buildKey) {
      setStep("review");
      return;
    }
    setBusy(true);
    try {
      const sorted = sortExport(parsed?.messages ?? [], known.messages, known.pending, account.currency);
      const existing = await listTransactions([account.id]);
      const next = [
        ...restorePending(known.pending, sorted.rows, account.currency, nextKey.current),
        ...markDuplicates(sorted.rows, existing, offset),
      ];
      nextKey.current += known.pending.length * 100;
      setRows(next);
      setEdited(sorted.edited);
      setBalanceMinor(
        existing.reduce((sum, x) => sum + (parseMoneyToMinor(x.credit) ?? 0) - (parseMoneyToMinor(x.debit) ?? 0), 0),
      );
      setTab(next.some((r) => r.bucket === "review") ? "review" : "out");
      builtFor.current = buildKey;
      setStep("review");
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  const update = useCallback((key: number, patch: Partial<WizardRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  const move = useCallback((key: number, bucket: Bucket) => {
    setRows((rs) => rs.map((r) => (r.key === key ? moved(r, bucket) : r)));
  }, []);

  const split = useCallback(
    (key: number) => {
      setRows((rs) => {
        const index = rs.findIndex((r) => r.key === key);
        if (index < 0) return rs;
        const row = rs[index];
        const part = (over: Partial<WizardRow>): WizardRow => ({
          ...row,
          key: nextKey.current++,
          amount: "",
          comment: "",
          categoryId: null,
          reasons: [],
          duplicateOf: null,
          isPart: true,
          ...over,
        });
        const lines = row.isPart ? [] : splitList(row.text, account.currency);
        const inserted =
          lines.length > 0
            ? lines.map((line) => part({ ...line, bucket: row.bucket === "review" ? "out" : row.bucket }))
            : [row, part({})];
        return [...rs.slice(0, index), ...inserted, ...rs.slice(index + 1)];
      });
    },
    [account.currency],
  );

  const remove = useCallback((key: number) => {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }, []);

  const pickCategory = useCallback((key: number, rect: DOMRect) => {
    setPicker({ key, rect });
  }, []);

  const partsByMessage = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.messageId, (counts.get(r.messageId) ?? 0) + 1);
    return counts;
  }, [rows]);

  const countOf = (b: Bucket) => rows.filter((r) => r.bucket === b).length;
  const totalOf = (b: "in" | "out") =>
    rows.filter((r) => r.bucket === b).reduce((sum, r) => sum + (parseMoneyToMinor(r.amount) ?? 0), 0);
  const invalidCount = rows.filter(isInvalid).length;
  const plan = useMemo(() => (step === "summary" ? planImport(rows, offset) : null), [step, rows, offset]);
  const entryCount = plan ? plan.decisions.reduce((sum, d) => sum + d.entries.length, 0) : 0;
  const skipCount = plan ? plan.decisions.filter((d) => d.entries.length === 0).length : 0;

  async function commit() {
    if (!plan || invalidCount > 0) return;
    setBusy(true);
    setError(null);
    try {
      await commitTelegramImport({
        accountId: account.id,
        title,
        timezoneOffset: offset,
        sourceFilename: fileName,
        decisions: plan.decisions,
        pending: plan.pending,
        edited: edited.map((e) => ({ messageId: e.messageId, text: e.after })),
      });
      await onChanged();
      onClose();
    } catch (err) {
      showError(err);
      setBusy(false);
    }
  }

  async function rollback(batchId: number) {
    setBusy(true);
    setError(null);
    try {
      await deleteTelegramImport(account.id, batchId);
      await reloadKnown();
      builtFor.current = null;
      setConfirmingRollback(null);
      await onChanged();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function saveTitle() {
    setBusy(true);
    setError(null);
    try {
      await setTelegramChannel({ accountId: account.id, title, timezoneOffset: offset });
      await reloadKnown();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  const badDates = parsed?.badDates ?? [];
  const pendingCount = known?.pending.length ?? 0;
  const canContinue =
    parsed !== null &&
    known !== null &&
    parsed.messages.length > 0 &&
    badDates.length === 0 &&
    !titleConflict &&
    !boundElsewhere &&
    title.trim().length > 0;

  const visible = tab === "edited" ? [] : rows.filter((r) => r.bucket === tab);
  const pickerRow = picker ? rows.find((r) => r.key === picker.key) : undefined;
  const period =
    parsed && parsed.messages.length > 0
      ? { from: parsed.messages[0].date, to: parsed.messages[parsed.messages.length - 1].date }
      : null;

  return createPortal(
    <>
      {/* No closing on a click outside: an hour of corrections is at stake. */}
      <div className="modal-backdrop">
        <div className={`modal ${step === "file" ? "modal--cash-dictation" : "modal--wide"}`}>
          <header className="modal-header">
            <h3>{t("accounts.cash.telegram.title", { account: account.name || account.currency })}</h3>
            {!busy && step === "file" && (
              <button className="icon-btn" onClick={onClose} aria-label={t("common.close")} type="button">
                ×
              </button>
            )}
          </header>

          {step === "file" && (
            <div className="modal-body telegram-file-step">
              <p className="hint">{t("accounts.cash.telegram.intro")}</p>
              <p className="hint">{t("accounts.cash.telegram.notation")}</p>
              <label className="import-field">
                <span>{t("accounts.cash.telegram.file")}</span>
                <input type="file" accept=".html,.htm,text/html" multiple onChange={pickFiles} disabled={busy} />
              </label>
              <label className="import-field">
                <span>{t("accounts.cash.telegram.channel")}</span>
                <span className="telegram-title-row">
                  <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
                  {boundTitle !== null && !parsed && title.trim() !== boundTitle && (
                    <button type="button" className="btn-ghost" onClick={saveTitle} disabled={busy || !title.trim()}>
                      {t("common.save")}
                    </button>
                  )}
                </span>
              </label>
              <label className="import-field">
                <span>{t("accounts.cash.telegram.timezone")}</span>
                <select value={offset} onChange={(e) => setOffset(e.target.value)} disabled={busy}>
                  {UTC_OFFSETS.map((o) => (
                    <option key={o} value={o}>
                      UTC{o}
                    </option>
                  ))}
                </select>
              </label>
              <p className="hint">{t("accounts.cash.telegram.timezoneHint")}</p>

              {titleConflict && (
                <div className="cash-dictation-notes">
                  <p>{t("accounts.cash.telegram.titleConflict", { file: fileTitle ?? "", bound: boundTitle ?? "" })}</p>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      setRenameConfirmed(true);
                      setTitle(fileTitle ?? "");
                    }}
                  >
                    {t("accounts.cash.telegram.titleRenamed")}
                  </button>{" "}
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      setParsed(null);
                      setFileName(null);
                    }}
                  >
                    {t("accounts.cash.telegram.titleOther")}
                  </button>
                </div>
              )}
              {boundElsewhere && (
                <div className="error">
                  {t("accounts.cash.telegram.boundElsewhere", { account: boundElsewhere.accountName })}
                </div>
              )}
              {parsed && parsed.messages.length === 0 && badDates.length === 0 && (
                <div className="error">{t("accounts.cash.telegram.noMessages")}</div>
              )}
              {badDates.length > 0 && (
                <div className="error">
                  {t("accounts.cash.telegram.badDates", { count: badDates.length, sample: badDates[0] })}
                </div>
              )}
              {preview && period && (
                <div className="cash-dictation-summary telegram-file-stats">
                  <span>{t("accounts.cash.telegram.statsPeriod", period)}</span>
                  <span>{t("accounts.cash.telegram.statsNew", { count: preview.rows.length })}</span>
                  <span>{t("accounts.cash.telegram.statsImported", { count: preview.alreadyImported })}</span>
                  <span>{t("accounts.cash.telegram.statsSkipped", { count: preview.alreadySkipped })}</span>
                  <span>{t("accounts.cash.telegram.statsPending", { count: preview.alreadyPending })}</span>
                  <span>{t("accounts.cash.telegram.statsEdited", { count: preview.edited.length })}</span>
                  <span>{t("accounts.cash.telegram.statsIgnored", { count: parsed?.ignored ?? 0 })}</span>
                </div>
              )}

              {pendingCount > 0 && !parsed && (
                <div className="cash-dictation-notes">
                  {t("accounts.cash.telegram.pendingSaved", { count: pendingCount })}{" "}
                  <button type="button" className="btn-ghost" onClick={toReview} disabled={busy}>
                    {t("accounts.cash.telegram.pendingOpen")}
                  </button>
                </div>
              )}

              {known && known.batches.length > 0 && (
                <>
                  <h4 className="telegram-batches-title">{t("accounts.cash.telegram.batches")}</h4>
                  <ul className="telegram-batches">
                    {known.batches.map((b) => (
                      <li key={b.id}>
                        <span>
                          {new Date(b.importedAt).toLocaleString(locale)}
                          {b.sourceFilename ? ` · ${b.sourceFilename}` : ""}
                          {" · "}
                          {t("accounts.cash.telegram.batchCounts", { imported: b.imported, skipped: b.skipped })}
                        </span>
                        {confirmingRollback === b.id ? (
                          <span>
                            {t("accounts.cash.telegram.rollbackConfirm", { count: b.imported })}{" "}
                            <button type="button" className="btn-danger-ghost" onClick={() => rollback(b.id)} disabled={busy}>
                              {t("accounts.cash.telegram.rollback")}
                            </button>{" "}
                            <button type="button" className="btn-ghost" onClick={() => setConfirmingRollback(null)} disabled={busy}>
                              {t("common.cancel")}
                            </button>
                          </span>
                        ) : (
                          <button type="button" className="btn-ghost" onClick={() => setConfirmingRollback(b.id)} disabled={busy}>
                            {t("accounts.cash.telegram.rollback")}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {error && <div className="error">{error}</div>}
            </div>
          )}

          {step === "review" && (
            <div className="modal-body">
              <div className="modal-tabs">
                {BUCKETS.map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={`modal-tab-button${tab === b ? " active" : ""}`}
                    onClick={() => setTab(b)}
                  >
                    {t(`accounts.cash.telegram.bucket.${b}`)} ({countOf(b)})
                  </button>
                ))}
                {edited.length > 0 && (
                  <button
                    type="button"
                    className={`modal-tab-button${tab === "edited" ? " active" : ""}`}
                    onClick={() => setTab("edited")}
                  >
                    {t("accounts.cash.telegram.editedTab")} ({edited.length})
                  </button>
                )}
              </div>
              {tab === "edited" ? (
                <>
                  <p className="hint">{t("accounts.cash.telegram.editedHint")}</p>
                  <table className="cash-dictation-table">
                    <thead>
                      <tr>
                        <th>{t("accounts.cash.telegram.editedBefore")}</th>
                        <th>{t("accounts.cash.telegram.editedAfter")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {edited.map((e) => (
                        <tr key={e.messageId}>
                          <td className="telegram-source-text">{e.before}</td>
                          <td className="telegram-source-text">{e.after}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : (
                <>
                  <div className="telegram-tab-tools">
                    <p className="hint">{t(`accounts.cash.telegram.bucketHint.${tab}`)}</p>
                    {visible.length > 0 && (
                      <label>
                        {t("accounts.cash.telegram.moveAll")}{" "}
                        <select
                          value=""
                          onChange={(e) => {
                            const bucket = e.target.value as Bucket;
                            setRows((rs) => rs.map((r) => (r.bucket === tab ? moved(r, bucket) : r)));
                          }}
                        >
                          <option value="" disabled>
                            {t("accounts.cash.telegram.moveAllPlaceholder")}
                          </option>
                          {BUCKETS.filter((b) => b !== tab).map((b) => (
                            <option key={b} value={b}>
                              {t(`accounts.cash.telegram.bucket.${b}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  {visible.length === 0 ? (
                    <p className="empty">{t("accounts.cash.telegram.emptyTab")}</p>
                  ) : (
                    <table className="cash-dictation-table telegram-table">
                      <thead>
                        <tr>
                          <th>{t("accounts.cash.telegram.colWhen")}</th>
                          <th>{t("accounts.cash.colAmount")}</th>
                          <th>{t("accounts.cash.colComment")}</th>
                          <th>{t("accounts.cash.dictation.colCategory")}</th>
                          <th>{t("accounts.cash.telegram.colGroup")}</th>
                          <th>{t("accounts.cash.telegram.colSource")}</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map((r) => (
                          <RowView
                            key={r.key}
                            row={r}
                            categoryPath={r.categoryId !== null ? pathOf(r.categoryId) : null}
                            categoryColor={r.categoryId !== null ? colorOf.get(r.categoryId) : undefined}
                            removable={(partsByMessage.get(r.messageId) ?? 0) > 1}
                            onUpdate={update}
                            onMove={move}
                            onSplit={split}
                            onRemove={remove}
                            onPickCategory={pickCategory}
                          />
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
              {error && <div className="error">{error}</div>}
            </div>
          )}

          {step === "summary" && plan && (
            <div className="modal-body">
              <ul className="telegram-summary">
                <li>{t("accounts.cash.telegram.summaryOut", { count: countOf("out"), amount: money(totalOf("out")) })}</li>
                <li>{t("accounts.cash.telegram.summaryIn", { count: countOf("in"), amount: money(totalOf("in")) })}</li>
                <li>{t("accounts.cash.telegram.summarySkipped", { count: skipCount })}</li>
                <li>{t("accounts.cash.telegram.summaryDeferred", { count: plan.pending.length })}</li>
                <li>
                  {t("accounts.cash.telegram.summaryBalance", {
                    before: money(balanceMinor),
                    after: money(balanceMinor + totalOf("in") - totalOf("out")),
                  })}
                </li>
              </ul>
              {plan.pending.length > 0 && <p className="hint">{t("accounts.cash.telegram.deferredHint")}</p>}
              {invalidCount > 0 && <div className="error">{t("accounts.cash.telegram.invalidRows", { count: invalidCount })}</div>}
              {error && <div className="error">{error}</div>}
            </div>
          )}

          <footer className="modal-footer">
            {step !== "file" && (
              <button
                type="button"
                className="btn-ghost modal-footer-left"
                onClick={() => {
                  setError(null);
                  setStep(step === "summary" ? "review" : "file");
                }}
                disabled={busy}
              >
                {t("common.back")}
              </button>
            )}
            <button
              type="button"
              className={closeArmed ? "btn-danger-ghost" : "btn-ghost"}
              onClick={() => (step === "file" || closeArmed ? onClose() : setCloseArmed(true))}
              onBlur={() => setCloseArmed(false)}
              disabled={busy}
            >
              {closeArmed ? t("accounts.cash.telegram.closeConfirm") : t("common.cancel")}
            </button>
            {step === "file" && (
              <button type="button" className="btn-primary" onClick={toReview} disabled={busy || !canContinue}>
                {t("accounts.cash.telegram.toReview")}
              </button>
            )}
            {step === "review" && (
              <button type="button" className="btn-primary" onClick={() => setStep("summary")} disabled={busy}>
                {t("accounts.cash.telegram.toSummary")}
              </button>
            )}
            {step === "summary" && plan && (
              <button
                type="button"
                className="btn-primary"
                onClick={commit}
                disabled={
                  busy || invalidCount > 0 || (plan.decisions.length === 0 && plan.pending.length === 0 && edited.length === 0)
                }
              >
                {busy
                  ? t("common.saving")
                  : entryCount > 0
                    ? t("accounts.cash.telegram.commit", { count: entryCount })
                    : t("common.save")}
              </button>
            )}
          </footer>
        </div>
      </div>
      {/* Outside the backdrop: React events bubble through portals. */}
      {picker && pickerRow && (
        <CategoryPickerPopover
          kind={pickerRow.bucket === "in" ? "income" : "expense"}
          // The `<<--->>` transfer categories belong to linked pairs only.
          excludeIds={systemIds}
          anchorRect={picker.rect}
          onPick={(c) => {
            update(picker.key, { categoryId: c.id });
            setPicker(null);
          }}
          onClear={() => {
            update(picker.key, { categoryId: null });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>,
    document.body,
  );
}
