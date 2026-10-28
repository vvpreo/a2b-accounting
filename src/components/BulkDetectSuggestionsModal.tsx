import { useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import {
  Suggestion,
  SuggestionRunSummary,
  Transaction,
  detectCashWithdrawals,
  detectTransfers,
} from "../lib/api";

export type DetectKind = "cash_withdrawal" | "transfer";

interface Props {
  kind: DetectKind;
  /// The selected, currently-visible transactions.
  transactions: Transaction[];
  /// Pending suggestions, to count the selected rows that already have one.
  suggestions: Suggestion[];
  onClose: () => void;
  /// After the run, so the table reloads the suggestions.
  onDone: () => void;
}

type Phase = "confirm" | "running" | "done";

/// Bulk "Find cash withdrawals" / "Find transfers between accounts": one
/// rule-based backend run over the whole selection (transfers are paired
/// across the selection at once, so it is a single call, not per row).
/// Nothing is applied — suggestions appear in the Suggestion column.
export function BulkDetectSuggestionsModal({ kind, transactions, suggestions, onClose, onDone }: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("confirm");
  const [redo, setRedo] = useState(false);
  const [summary, setSummary] = useState<SuggestionRunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = new Set(transactions.map((x) => x.id));
  const alreadySuggested = new Set(
    suggestions.filter((s) => s.kind === kind && selected.has(s.transactionId)).map((s) => s.transactionId),
  ).size;

  async function run() {
    setPhase("running");
    setError(null);
    try {
      const ids = transactions.map((x) => x.id);
      setSummary(kind === "transfer" ? await detectTransfers(ids, redo) : await detectCashWithdrawals(ids, redo));
    } catch (e) {
      setError(String(e));
    }
    setPhase("done");
  }

  function close() {
    if (phase === "running") return;
    if (phase === "done") onDone();
    onClose();
  }

  const skipped = summary ? Object.entries(summary.skipped).sort((a, b) => b[1] - a[1]) : [];

  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal modal--bulk-docs" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{t(`suggestions.run.${kind}.title`)}</h3>
          {phase !== "running" && (
            <button className="icon-btn" onClick={close} aria-label={t("common.close")} type="button">
              ×
            </button>
          )}
        </header>
        <div className="modal-body">
          {phase === "confirm" && (
            <>
              <p>{t(`suggestions.run.${kind}.intro`, { count: transactions.length })}</p>
              <p className="hint">{t("suggestions.run.nothingApplied")}</p>
              {alreadySuggested > 0 && (
                <label className="checkbox-row">
                  <input type="checkbox" checked={redo} onChange={(e) => setRedo(e.target.checked)} />
                  <span>{t("suggestions.run.redo", { count: alreadySuggested })}</span>
                </label>
              )}
            </>
          )}
          {phase === "running" && <p>{t("suggestions.run.running")}</p>}
          {phase === "done" && (
            <>
              {error ? (
                <div className="error">{error}</div>
              ) : (
                summary && (
                  <>
                    <p>{t(`suggestions.run.${kind}.result`, { count: summary.suggested })}</p>
                    {skipped.length > 0 && (
                      <ul className="suggestion-skips">
                        {skipped.map(([reason, n]) => (
                          <li key={reason}>
                            {t(`suggestions.skip.${reason}`)}: {n}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )
              )}
            </>
          )}
        </div>
        <footer className="modal-footer">
          {phase === "confirm" && (
            <>
              <button type="button" className="btn-ghost" onClick={close}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn-primary" onClick={run} disabled={transactions.length === 0}>
                {t("transactions.bulkDocs.start")}
              </button>
            </>
          )}
          {phase === "done" && (
            <button type="button" className="btn-primary" onClick={close}>
              {t("common.close")}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
