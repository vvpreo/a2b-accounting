import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import {
  Account,
  Category,
  Suggestion,
  Transaction,
  applySuggestion,
  detectCashWithdrawals,
  detectTransfers,
  dismissSuggestion,
} from "../../lib/api";
import { formatMoney } from "../../lib/money";
import { isUnsure } from "../../lib/suggestion-state";
import { useT } from "../../i18n";

/** Lookups the cell and its dialog need to describe a suggestion's target. */
export interface SuggestionLookups {
  txnById: Map<number, Transaction>;
  accountById: Map<number, Account>;
  categoryById: Map<number, Category>;
  /** ISO instant → local wall-time label. */
  formatDate: (iso: string) => string;
  /** Backend error code → localised message. */
  localizeError: (code: string) => string;
  /** The agent's threshold (Settings → AI): its category answers below it are
   *  "agent not sure" marks. */
  agentMinConfidence: number;
}

interface Props extends SuggestionLookups {
  txn: Transaction;
  /** Pending suggestions for this transaction (empty when none). */
  suggestions: Suggestion[];
  /** The note shown in the Note column (comment, else slip note). */
  note: string | null;
  /** After a suggestion was applied, dismissed or recomputed. */
  onChanged: () => void;
}

const KIND_ORDER: Suggestion["kind"][] = ["cash_withdrawal", "transfer", "category"];

export function categoryPath(id: number, byId: Map<number, Category>): string {
  const names: string[] = [];
  let cur = byId.get(id);
  while (cur && names.length < 8) {
    names.unshift(cur.name);
    cur = cur.parentId !== null ? byId.get(cur.parentId) : undefined;
  }
  return names.join(" / ");
}

function accountLabel(acc: Account | undefined): string {
  return acc ? acc.name || acc.accountNumber || acc.bank : "—";
}


function confidenceClass(c: number): string {
  if (c >= 8) return "is-high";
  if (c >= 5) return "is-mid";
  return "is-low";
}

/** One-line description of what the suggestion would do. */
function useTargetLabel(l: SuggestionLookups) {
  const t = useT();
  return (s: Suggestion): string => {
    switch (s.kind) {
      case "cash_withdrawal":
        return t("suggestions.chip.cash", {
          account: accountLabel(s.cashAccountId !== null ? l.accountById.get(s.cashAccountId) : undefined),
        });
      case "transfer": {
        const partner = s.partnerTxnId !== null ? l.txnById.get(s.partnerTxnId) : undefined;
        return t("suggestions.chip.transfer", {
          account: accountLabel(partner ? l.accountById.get(partner.accountId) : undefined),
          time: partner ? l.formatDate(partner.occurredAtUtc).slice(11) : "—",
        });
      }
      case "category":
        return s.categoryId !== null && !isUnsure(s, l.agentMinConfidence)
          ? categoryPath(s.categoryId, l.categoryById)
          : t("suggestions.unsure");
    }
  };
}

function KindIcon({
  s,
  categoryById,
  minConfidence,
}: {
  s: Suggestion;
  categoryById: Map<number, Category>;
  minConfidence: number;
}) {
  if (s.kind === "cash_withdrawal") return <span aria-hidden="true">💵</span>;
  if (s.kind === "transfer") return <span aria-hidden="true">🔗</span>;
  if (isUnsure(s, minConfidence)) return <span className="suggestion-unsure-icon" aria-hidden="true">?</span>;
  const color = s.categoryId !== null ? categoryById.get(s.categoryId)?.color : undefined;
  return <span className="suggestion-dot" style={{ background: color ?? "#a1a1aa" }} aria-hidden="true" />;
}

/** The "Suggestion" column: the most important pending suggestion as a chip
 *  (cash withdrawal, then transfer, then category) with its confidence; a
 *  click opens the dialog with every suggestion, its rationale and the
 *  model's reasoning. Empty when there is nothing to suggest. */
export function SuggestionCell({ txn, suggestions, note, onChanged, ...lookups }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const label = useTargetLabel(lookups);
  const sorted = [...suggestions].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
  const main = sorted[0];

  return (
    <td className="col-suggestion">
      {main && (
        <button
          type="button"
          className={`suggestion-cell suggestion-cell--${main.kind}${isUnsure(main, lookups.agentMinConfidence) ? " suggestion-cell--unsure" : ""}`}
          title={isUnsure(main, lookups.agentMinConfidence) ? `${label(main)}\n${main.rationale}` : `${label(main)} · ${main.confidence}/10\n${main.rationale}`}
          onClick={() => setOpen(true)}
        >
          <KindIcon s={main} categoryById={lookups.categoryById} minConfidence={lookups.agentMinConfidence} />
          <span className="suggestion-cell-text">{label(main)}</span>
          {!isUnsure(main, lookups.agentMinConfidence) && (
            <span className={`suggestion-confidence ${confidenceClass(main.confidence)}`}>
              {main.confidence}
            </span>
          )}
          {sorted.length > 1 && (
            <span className="suggestion-more" title={t("suggestions.more", { count: sorted.length - 1 })}>
              +{sorted.length - 1}
            </span>
          )}
        </button>
      )}
      {open && (
        <SuggestionsModal
          txn={txn}
          suggestions={sorted}
          note={note}
          lookups={lookups}
          onChanged={onChanged}
          onClose={() => setOpen(false)}
        />
      )}
    </td>
  );
}

function SuggestionsModal({
  txn,
  suggestions,
  note,
  lookups,
  onChanged,
  onClose,
}: {
  txn: Transaction;
  suggestions: Suggestion[];
  note: string | null;
  lookups: SuggestionLookups;
  onChanged: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const label = useTargetLabel(lookups);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const acc = lookups.accountById.get(txn.accountId);
  const incoming = txn.credit !== "0.00";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && busy === null && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function act(s: Suggestion, action: "apply" | "dismiss" | "recompute") {
    setBusy(s.id);
    setError(null);
    try {
      if (action === "apply") await applySuggestion(s.id);
      else if (action === "dismiss") await dismissSuggestion(s.id);
      else if (s.kind === "cash_withdrawal") await detectCashWithdrawals([txn.id], true);
      else if (s.kind === "transfer") await detectTransfers([txn.id], true);
      onChanged();
      if (action !== "recompute") onClose();
    } catch (e) {
      setError(lookups.localizeError(String(e)));
    } finally {
      setBusy(null);
    }
  }

  return createPortal(
    <div className="modal-backdrop" onClick={() => busy === null && onClose()}>
      <div className="modal modal--suggestions" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div className="txn-modal-title">
            <h3>{t("suggestions.title")}</h3>
            <span className="txn-modal-subtitle">
              {accountLabel(acc)}
              {acc ? ` · ${acc.currency}` : ""} · {lookups.formatDate(txn.occurredAtUtc)} ·{" "}
              <span className={incoming ? "amount-credit" : "amount-debit"}>
                {incoming ? "+" : "−"}
                {formatMoney(incoming ? txn.credit : txn.debit)}
              </span>
            </span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")} type="button">
            ×
          </button>
        </header>
        <div className="modal-body">
          <dl className="document-fields">
            {[
              [t("transaction.fieldPeer"), txn.peer],
              [t("transaction.fieldDescription"), txn.bankDescription],
              [t("transactions.tableNote"), note],
            ].map(([k, v]) => (
              <div key={k} className="document-field">
                <dt>{k}</dt>
                <dd>{v || <span className="hint">—</span>}</dd>
              </div>
            ))}
          </dl>

          {error && <div className="error">{error}</div>}

          {suggestions.map((s) => {
            const partner = s.partnerTxnId !== null ? lookups.txnById.get(s.partnerTxnId) : undefined;
            const partnerAcc = partner ? lookups.accountById.get(partner.accountId) : undefined;
            return (
              <section key={s.id} className="suggestion-card">
                <div className="suggestion-card-head">
                  <KindIcon s={s} categoryById={lookups.categoryById} minConfidence={lookups.agentMinConfidence} />
                  <span className="suggestion-card-kind">{t(`suggestions.kind.${s.kind}`)}</span>
                  <span className="suggestion-card-target">{label(s)}</span>
                  {!isUnsure(s, lookups.agentMinConfidence) && (
                    <span className={`suggestion-confidence ${confidenceClass(s.confidence)}`}>
                      {t("suggestions.confidence", { value: s.confidence })}
                    </span>
                  )}
                </div>
                <p className="suggestion-rationale">
                  <span className="txn-field-label">
                    {isUnsure(s, lookups.agentMinConfidence) ? t("suggestions.unsureRationale") : t("suggestions.rationale")}
                  </span>
                  {s.rationale}
                </p>
                {isUnsure(s, lookups.agentMinConfidence) && <p className="hint">{t("suggestions.unsureHint")}</p>}
                {partner && (
                  <div className="suggestion-partner">
                    <span className="txn-field-label">{t("suggestions.partner")}</span>
                    <span>
                      {accountLabel(partnerAcc)}
                      {partnerAcc ? ` · ${partnerAcc.currency}` : ""} · {lookups.formatDate(partner.occurredAtUtc)} ·{" "}
                      <span className={partner.credit !== "0.00" ? "amount-credit" : "amount-debit"}>
                        {partner.credit !== "0.00" ? "+" : "−"}
                        {formatMoney(partner.credit !== "0.00" ? partner.credit : partner.debit)}
                      </span>
                    </span>
                    {(partner.peer || partner.bankDescription) && (
                      <span className="hint">
                        {[partner.peer, partner.bankDescription].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </div>
                )}
                {s.kind === "cash_withdrawal" && (
                  <p className="hint">{t("suggestions.cashHint", { amount: formatMoney(txn.debit) })}</p>
                )}
                {s.reasoning && (
                  <details className="suggestion-details">
                    <summary>{t("suggestions.reasoning")}</summary>
                    <pre>{s.reasoning}</pre>
                  </details>
                )}
                {s.prompt && (
                  <details className="suggestion-details">
                    <summary>{t("suggestions.prompt", { model: s.model ?? "" })}</summary>
                    <pre>{s.prompt}</pre>
                  </details>
                )}
                <div className="suggestion-card-actions">
                  {s.source === "rule" && (
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={busy !== null}
                      onClick={() => void act(s, "recompute")}
                    >
                      {t("suggestions.recompute")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy !== null}
                    onClick={() => void act(s, "dismiss")}
                  >
                    {t("suggestions.dismiss")}
                  </button>
                  {!isUnsure(s, lookups.agentMinConfidence) && (
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={busy !== null}
                      onClick={() => void act(s, "apply")}
                    >
                      {busy === s.id ? t("common.saving") : t("suggestions.apply")}
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
