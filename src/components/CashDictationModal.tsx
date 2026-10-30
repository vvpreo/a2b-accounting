import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n, useT } from "../i18n";
import {
  Account,
  CashDirection,
  CashDraft,
  Category,
  Transaction,
  createCashEntries,
  draftCashEntries,
  listCategories,
} from "../lib/api";
import { parseMoneyToMinor } from "../lib/money";
import { useViewState } from "../lib/view-state";
import { CategoryPickerPopover } from "./CategoryPickerPopover";

interface Props {
  account: Account;
  /// The account's current entries — rows matching one of them are flagged
  /// as possible duplicates.
  existing: Transaction[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}

interface Row {
  key: number;
  include: boolean;
  date: string;
  direction: CashDirection;
  amount: string;
  categoryId: number | null;
  peer: string;
  comment: string;
  ruleIndex: number | null;
  movedToMonthEnd: boolean;
  categoryDropped: boolean;
  /// As the agent proposed it — to count the rows the owner corrected.
  original: string;
}

const ERROR_KEYS: Record<string, string> = {
  "agent.no_connection": "accounts.cash.dictation.errorNoConnection",
  "cash_dictation.empty": "accounts.cash.dictation.errorEmpty",
  "cash_dictation.too_many_rows": "accounts.cash.dictation.errorTooMany",
};

/** The fields that make a row what it is, for "was it edited". */
function signature(r: Pick<Row, "date" | "direction" | "amount" | "categoryId" | "peer" | "comment">): string {
  return JSON.stringify([r.date, r.direction, parseMoneyToMinor(r.amount), r.categoryId, r.peer.trim(), r.comment.trim()]);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function duplicateKey(date: string, direction: CashDirection, minor: number | null): string {
  return `${date}|${direction}|${minor}`;
}

/// Records → "Entries from a description": the owner describes the entries in
/// free text, the agent's model returns a plan, the server expands it into
/// dated rows, and the owner checks / corrects them here before anything is
/// created. See docs/plans/cash-dictation.md.
export function CashDictationModal({ account, existing, onClose, onCreated }: Props) {
  const t = useT();
  const { locale } = useI18n();
  // The description survives closing the window: refine it and ask again.
  const [text, setText] = useViewState<string>(`cashDictation.text.${account.id}`, "");
  const [draft, setDraft] = useState<CashDraft | null>(null);
  // The description this draft was prepared from, shown above the preview.
  const [draftText, setDraftText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<"draft" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [picker, setPicker] = useState<{ key: number; rect: DOMRect } | null>(null);

  useEffect(() => {
    listCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

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

  const existingKeys = useMemo(
    () =>
      new Set(
        existing.map((x) => {
          const incoming = Number(x.credit) > 0;
          return duplicateKey(
            localDate(new Date(x.occurredAtUtc)),
            incoming ? "in" : "out",
            parseMoneyToMinor(incoming ? x.credit : x.debit),
          );
        }),
      ),
    [existing],
  );
  const isDuplicate = (r: Pick<Row, "date" | "direction" | "amount">) =>
    existingKeys.has(duplicateKey(r.date, r.direction, parseMoneyToMinor(r.amount)));

  const moneyFmt = useMemo(() => {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: account.currency });
    } catch {
      return null;
    }
  }, [locale, account.currency]);
  const money = (minor: number) => (moneyFmt ? moneyFmt.format(minor / 100) : `${(minor / 100).toFixed(2)} ${account.currency}`);

  async function prepare() {
    setBusy("draft");
    setError(null);
    try {
      const now = new Date();
      const result = await draftCashEntries({
        accountId: account.id,
        text,
        today: localDate(now),
        tzOffsetMinutes: -now.getTimezoneOffset(),
      });
      const next = result.rows.map((r, i): Row => {
        const row = {
          key: i,
          date: r.date,
          direction: r.direction,
          amount: r.amount,
          categoryId: r.categoryId,
          peer: r.peer ?? "",
          comment: r.comment ?? "",
          ruleIndex: r.ruleIndex,
          movedToMonthEnd: r.movedToMonthEnd,
          categoryDropped: r.categoryDropped,
        };
        return { ...row, include: !isDuplicate(row), original: signature(row) };
      });
      setDraft(result);
      setDraftText(text.trim());
      setRows(next);
    } catch (e) {
      const message = String(e);
      setError(ERROR_KEYS[message] ? t(ERROR_KEYS[message]) : message);
    } finally {
      setBusy(null);
    }
  }

  function update(key: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  const included = rows.filter((r) => r.include);
  const invalid = new Set(
    included.filter((r) => !r.date || !((parseMoneyToMinor(r.amount) ?? 0) > 0)).map((r) => r.key),
  );
  const totalOf = (direction: CashDirection) =>
    included.filter((r) => r.direction === direction).reduce((sum, r) => sum + (parseMoneyToMinor(r.amount) ?? 0), 0);

  async function create() {
    if (!draft || included.length === 0 || invalid.size > 0) return;
    setBusy("create");
    setError(null);
    try {
      await createCashEntries({
        accountId: account.id,
        // Midday local: a UTC day boundary must not move an entry into the
        // neighbouring month of the report.
        entries: included.map((r) => ({
          occurredAtUtc: new Date(`${r.date}T12:00`).toISOString(),
          direction: r.direction,
          amount: r.amount.trim().replace(/\s+/g, "").replace(",", "."),
          categoryId: r.categoryId,
          peer: r.peer.trim() || null,
          comment: r.comment.trim() || null,
        })),
        logId: draft.logId,
        proposed: rows.length,
        edited: included.filter((r) => signature(r) !== r.original).length,
      });
      setText("");
      await onCreated();
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }

  const pickerRow = picker ? rows.find((r) => r.key === picker.key) : undefined;

  return createPortal(
    <>
      <div className="modal-backdrop" onClick={() => !busy && onClose()}>
        <div
          className={`modal ${draft ? "modal--wide" : "modal--cash-dictation"}`}
          onClick={(e) => e.stopPropagation()}
        >
          <header className="modal-header">
            <h3>{t("accounts.cash.dictation.title", { account: account.name || account.currency })}</h3>
            {!busy && (
              <button className="icon-btn" onClick={onClose} aria-label={t("common.close")} type="button">
                ×
              </button>
            )}
          </header>

          {!draft ? (
            <div className="modal-body">
              <p className="hint">{t("accounts.cash.dictation.intro")}</p>
              <textarea
                className="cash-dictation-text"
                rows={8}
                autoFocus
                value={text}
                placeholder={t("accounts.cash.dictation.placeholder")}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim() && !busy) prepare();
                }}
                disabled={busy !== null}
              />
              {busy === "draft" && <p className="hint">{t("accounts.cash.dictation.thinking")}</p>}
              {error && <div className="error">{error}</div>}
            </div>
          ) : (
            <div className="modal-body">
              <div className="cash-dictation-source">
                <strong>{t("accounts.cash.dictation.source")}</strong>
                <div>{draftText}</div>
              </div>
              <div className="cash-dictation-summary">
                <span>
                  {t("accounts.cash.dictation.summary", {
                    count: included.length,
                    total: rows.length,
                    rules: draft.ruleCount,
                    once: draft.onceCount,
                  })}
                </span>
                {totalOf("out") > 0 && (
                  <span>{t("accounts.cash.dictation.totalOut", { amount: money(totalOf("out")) })}</span>
                )}
                {totalOf("in") > 0 && (
                  <span>{t("accounts.cash.dictation.totalIn", { amount: money(totalOf("in")) })}</span>
                )}
              </div>
              {draft.notes && (
                <div className="cash-dictation-notes">
                  <strong>{t("accounts.cash.dictation.notes")}</strong> {draft.notes}
                </div>
              )}
              {rows.length === 0 ? (
                <p className="empty">{t("accounts.cash.dictation.noRows")}</p>
              ) : (
                <table className="cash-dictation-table">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          checked={included.length === rows.length}
                          onChange={(e) => setRows((rs) => rs.map((r) => ({ ...r, include: e.target.checked })))}
                          aria-label={t("accounts.cash.dictation.colInclude")}
                        />
                      </th>
                      <th>{t("accounts.cash.colDate")}</th>
                      <th>{t("accounts.cash.dictation.colDirection")}</th>
                      <th>{t("accounts.cash.colAmount")}</th>
                      <th>{t("accounts.cash.dictation.colCategory")}</th>
                      <th>{t("accounts.cash.colPeer")}</th>
                      <th>{t("accounts.cash.colComment")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const dup = isDuplicate(r);
                      return (
                        <tr key={r.key} className={r.include ? undefined : "is-excluded"}>
                          <td>
                            <input
                              type="checkbox"
                              checked={r.include}
                              onChange={(e) => update(r.key, { include: e.target.checked })}
                            />
                          </td>
                          <td>
                            <input
                              type="date"
                              value={r.date}
                              className={invalid.has(r.key) && !r.date ? "is-invalid" : undefined}
                              onChange={(e) => update(r.key, { date: e.target.value })}
                            />
                          </td>
                          <td>
                            <select
                              value={r.direction}
                              onChange={(e) =>
                                // A category belongs to one kind: switching
                                // the direction takes it off.
                                update(r.key, { direction: e.target.value as CashDirection, categoryId: null })
                              }
                            >
                              <option value="out">{t("accounts.cash.dictation.out")}</option>
                              <option value="in">{t("accounts.cash.dictation.in")}</option>
                            </select>
                          </td>
                          <td>
                            <input
                              inputMode="decimal"
                              className={`cash-dictation-amount${invalid.has(r.key) && r.date ? " is-invalid" : ""}`}
                              value={r.amount}
                              onChange={(e) => update(r.key, { amount: e.target.value })}
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="cash-dictation-category"
                              onClick={(e) => setPicker({ key: r.key, rect: e.currentTarget.getBoundingClientRect() })}
                            >
                              {r.categoryId !== null ? (
                                <>
                                  <span
                                    className="cash-dictation-dot"
                                    style={{ background: colorOf.get(r.categoryId) ?? "#a1a1aa" }}
                                  />
                                  {pathOf(r.categoryId)}
                                </>
                              ) : (
                                <span className="cash-dictation-placeholder">
                                  {t("accounts.cash.dictation.noCategory")}
                                </span>
                              )}
                            </button>
                          </td>
                          <td>
                            <input value={r.peer} onChange={(e) => update(r.key, { peer: e.target.value })} />
                          </td>
                          <td>
                            <input value={r.comment} onChange={(e) => update(r.key, { comment: e.target.value })} />
                          </td>
                          <td className="cash-dictation-marks">
                            {dup && (
                              <span className="cash-dictation-mark is-warn" title={t("accounts.cash.dictation.duplicateHint")}>
                                {t("accounts.cash.dictation.duplicate")}
                              </span>
                            )}
                            {r.movedToMonthEnd && (
                              <span className="cash-dictation-mark" title={t("accounts.cash.dictation.monthEndHint")}>
                                {t("accounts.cash.dictation.monthEnd")}
                              </span>
                            )}
                            {r.categoryDropped && r.categoryId === null && (
                              <span className="cash-dictation-mark is-warn" title={t("accounts.cash.dictation.categoryDroppedHint")}>
                                {t("accounts.cash.dictation.categoryDropped")}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {error && <div className="error">{error}</div>}
            </div>
          )}

          <footer className="modal-footer">
            {draft ? (
              <>
                <button
                  type="button"
                  className="btn-ghost modal-footer-left"
                  onClick={() => {
                    setDraft(null);
                    setRows([]);
                    setError(null);
                  }}
                  disabled={busy !== null}
                >
                  {t("accounts.cash.dictation.back")}
                </button>
                <button type="button" className="btn-ghost" onClick={onClose} disabled={busy !== null}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={create}
                  disabled={busy !== null || included.length === 0 || invalid.size > 0}
                >
                  {busy === "create"
                    ? t("common.saving")
                    : t("accounts.cash.dictation.create", { count: included.length })}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn-ghost" onClick={onClose} disabled={busy !== null}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={prepare}
                  disabled={busy !== null || !text.trim()}
                >
                  {busy === "draft" ? t("accounts.cash.dictation.preparing") : t("accounts.cash.dictation.prepare")}
                </button>
              </>
            )}
          </footer>
        </div>
      </div>
      {/* Outside the backdrop: React events bubble through portals, and a
          click in the popover must not close the window. */}
      {picker && pickerRow && (
        <CategoryPickerPopover
          kind={pickerRow.direction === "in" ? "income" : "expense"}
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
