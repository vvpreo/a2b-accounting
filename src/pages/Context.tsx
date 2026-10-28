import { FormEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n, useT } from "../i18n";
import {
  LifeContext,
  createLifeContext,
  deleteLifeContext,
  listLifeContexts,
  updateLifeContext,
} from "../lib/api";
import { ROOT_PALETTE, nextRootColor } from "../lib/colors";

/** Inclusive number of days in `from..to` (YYYY-MM-DD). */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** "Context" screen: date intervals of what was going on in life (a trip with
 *  the kids, an illness, …). Intervals may overlap. The Transactions screen
 *  shows the contexts of each transaction's day, and the category model gets
 *  them too. */
export function ContextPage() {
  const t = useT();
  const { locale } = useI18n();
  const [items, setItems] = useState<LifeContext[]>([]);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LifeContext | "new" | null>(null);

  useEffect(() => {
    let cancelled = false;
    listLifeContexts()
      .then((list) => !cancelled && setItems(list))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [version]);

  const formatDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(locale);

  return (
    <section className="page page--context">
      <header className="categories-section-header">
        <h2>{t("context.title")}</h2>
        <button type="button" className="btn-primary" onClick={() => setEditing("new")}>
          {t("context.add")}
        </button>
      </header>
      <p className="hint">{t("context.hint")}</p>
      {error && <div className="error">{error}</div>}

      {items.length === 0 ? (
        <p className="hint">{t("context.empty")}</p>
      ) : (
        <table className="contexts-table">
          <thead>
            <tr>
              <th />
              <th>{t("context.fieldTitle")}</th>
              <th>{t("context.period")}</th>
              <th className="num">{t("context.days")}</th>
              <th>{t("context.fieldNote")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} className="context-row" onClick={() => setEditing(c)} title={t("context.edit")}>
                <td>
                  <span className="context-swatch" style={{ background: c.color }} />
                </td>
                <td className="context-title">{c.title}</td>
                <td className="context-period">
                  {c.startsOn === c.endsOn
                    ? formatDay(c.startsOn)
                    : `${formatDay(c.startsOn)} – ${formatDay(c.endsOn)}`}
                </td>
                <td className="num">{daysBetween(c.startsOn, c.endsOn)}</td>
                <td className="context-note">{c.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing !== null && (
        <ContextFormModal
          context={editing === "new" ? null : editing}
          defaultColor={nextRootColor(items.map((c) => c.color))}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </section>
  );
}

function ContextFormModal({
  context,
  defaultColor,
  onClose,
  onSaved,
}: {
  context: LifeContext | null;
  defaultColor: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const today = new Date().toISOString().slice(0, 10);
  const [title, setTitle] = useState(context?.title ?? "");
  const [startsOn, setStartsOn] = useState(context?.startsOn ?? today);
  const [endsOn, setEndsOn] = useState(context?.endsOn ?? today);
  const [color, setColor] = useState(context?.color ?? defaultColor);
  const [note, setNote] = useState(context?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const localize = (e: unknown) => {
    const code = String(e);
    return code.startsWith("context.") ? t(`context.error.${code.slice("context.".length)}`) : code;
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const args = { title, startsOn, endsOn, color, note: note.trim() ? note.trim() : null };
      if (context) await updateLifeContext({ id: context.id, ...args });
      else await createLifeContext(args);
      onSaved();
    } catch (err) {
      setError(localize(err));
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!context) return;
    setBusy(true);
    try {
      await deleteLifeContext(context.id);
      onSaved();
    } catch (err) {
      setError(localize(err));
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{context ? t("context.editTitle") : t("context.createTitle")}</h3>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")} type="button">
            ×
          </button>
        </header>
        <form onSubmit={onSubmit}>
          <div className="modal-body">
            <div className="account-form category-form--modal">
              <label>
                {t("context.fieldTitle")}
                <input
                  required
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t("context.fieldTitlePlaceholder")}
                />
              </label>
              <div className="context-dates">
                <label>
                  {t("context.fieldFrom")}
                  <input
                    type="date"
                    required
                    value={startsOn}
                    onChange={(e) => {
                      setStartsOn(e.target.value);
                      // Keep the interval valid while the start moves forward.
                      if (e.target.value > endsOn) setEndsOn(e.target.value);
                    }}
                  />
                </label>
                <label>
                  {t("context.fieldTo")}
                  <input
                    type="date"
                    required
                    min={startsOn}
                    value={endsOn}
                    onChange={(e) => setEndsOn(e.target.value)}
                  />
                </label>
              </div>
              <label>
                {t("context.fieldNote")}
                <textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("context.fieldNotePlaceholder")}
                />
              </label>
              <div className="categories-color-field">
                <span className="categories-color-label">{t("context.fieldColor")}</span>
                <div className="categories-palette">
                  {ROOT_PALETTE.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={
                        c.toLowerCase() === color.toLowerCase()
                          ? "categories-swatch-btn is-selected"
                          : "categories-swatch-btn"
                      }
                      style={{ backgroundColor: c }}
                      onClick={() => setColor(c)}
                      aria-label={c}
                    />
                  ))}
                </div>
              </div>
            </div>

            {confirmingDelete && context && (
              <div className="delete-confirm">
                {t("context.deleteConfirm", { title: context.title })}
                <div className="delete-confirm-actions">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={busy}
                  >
                    {t("common.cancel")}
                  </button>
                  <button type="button" className="btn-danger" onClick={onDelete} disabled={busy}>
                    {busy ? t("common.deleting") : t("common.delete")}
                  </button>
                </div>
              </div>
            )}
            {error && <div className="error">{error}</div>}
          </div>
          <footer className="modal-footer">
            {context && (
              <button
                type="button"
                className="btn-danger-ghost modal-footer-left"
                onClick={() => setConfirmingDelete(true)}
                disabled={busy || confirmingDelete}
              >
                {t("common.delete")}
              </button>
            )}
            <button type="button" className="btn-ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy && !confirmingDelete ? t("common.saving") : t("common.save")}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}
