import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import { Suggestion, SuggestionKind, Transaction, applySuggestion } from "../lib/api";
import { isUnsure } from "../lib/suggestion-state";

interface Props {
  /// The selected, currently-visible transactions.
  transactions: Transaction[];
  /// All pending suggestions; the ones of the selected transactions count.
  suggestions: Suggestion[];
  /// The agent's threshold: its answers below it are "not sure" marks.
  agentMinConfidence: number;
  onClose: () => void;
  /// After the run: categories, links, cash transactions may have changed.
  onApplied: () => void;
}

type Phase = "choose" | "running" | "done";

const KINDS: SuggestionKind[] = ["category", "transfer", "cash_withdrawal"];
const LEVELS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

/// Actions ▾ → "Accept suggestions": the pending suggestions of the selection
/// broken down by confidence (and kind); the user picks "confidence at least
/// N" and which kinds, and they are applied one by one. "Agent not sure"
/// marks (no category) are never applied. A transfer is stored on both sides
/// — applying one side applies the pair, so the pair counts once.
export function BulkAcceptSuggestionsModal({ transactions, suggestions, agentMinConfidence, onClose, onApplied }: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("choose");
  const [minConfidence, setMinConfidence] = useState(9);
  const [kinds, setKinds] = useState<Set<SuggestionKind>>(() => new Set(KINDS));
  const [progress, setProgress] = useState({ done: 0, applied: 0, errors: 0, firstError: null as string | null });
  const stopRef = useRef(false);

  // Applicable suggestions of the selection, one per transfer pair.
  const candidates = useMemo(() => {
    const selected = new Set(transactions.map((x) => x.id));
    const seenPairs = new Set<string>();
    const out: Suggestion[] = [];
    for (const s of suggestions) {
      if (!selected.has(s.transactionId)) continue;
      if (isUnsure(s, agentMinConfidence)) continue;
      if (s.kind === "transfer" && s.partnerTxnId !== null) {
        const pair = [s.transactionId, s.partnerTxnId].sort((a, b) => a - b).join("-");
        if (seenPairs.has(pair)) continue;
        seenPairs.add(pair);
      }
      out.push(s);
    }
    return out;
  }, [transactions, suggestions, agentMinConfidence]);

  const count = (kind: SuggestionKind, level: number) =>
    candidates.filter((s) => s.kind === kind && s.confidence === level).length;
  const levels = LEVELS.filter((level) => candidates.some((s) => s.confidence === level));
  const presentKinds = KINDS.filter((k) => candidates.some((s) => s.kind === k));
  const chosen = candidates.filter((s) => kinds.has(s.kind) && s.confidence >= minConfidence);

  async function run() {
    setPhase("running");
    stopRef.current = false;
    let acc = { done: 0, applied: 0, errors: 0, firstError: null as string | null };
    for (const s of chosen) {
      if (stopRef.current) break;
      try {
        await applySuggestion(s.id);
        acc = { ...acc, applied: acc.applied + 1 };
      } catch (e) {
        acc = { ...acc, errors: acc.errors + 1, firstError: acc.firstError ?? String(e) };
      }
      acc = { ...acc, done: acc.done + 1 };
      setProgress(acc);
    }
    onApplied();
    setPhase("done");
  }

  function close() {
    if (phase !== "running") onClose();
  }

  function toggleKind(kind: SuggestionKind) {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal modal--bulk-docs" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{t("suggestions.accept.title")}</h3>
          {phase !== "running" && (
            <button className="icon-btn" onClick={close} aria-label={t("common.close")} type="button">
              ×
            </button>
          )}
        </header>
        <div className="modal-body">
          {phase === "choose" &&
            (candidates.length === 0 ? (
              <p className="hint">{t("suggestions.accept.none")}</p>
            ) : (
              <>
                <p>{t("suggestions.accept.intro", { count: candidates.length })}</p>
                <table className="accept-breakdown">
                  <thead>
                    <tr>
                      <th>{t("suggestions.accept.colConfidence")}</th>
                      {presentKinds.map((k) => (
                        <th key={k} className="num" title={t(`suggestions.kind.${k}`)}>
                          {t(`suggestions.accept.kindShort.${k}`)}
                        </th>
                      ))}
                      <th className="num">{t("suggestions.accept.colTotal")}</th>
                      <th className="num">{t("suggestions.accept.colAtLeast")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {levels.map((level) => {
                      const atLeast = candidates.filter((s) => kinds.has(s.kind) && s.confidence >= level).length;
                      return (
                        <tr
                          key={level}
                          className={level >= minConfidence ? "is-chosen" : undefined}
                          onClick={() => setMinConfidence(level)}
                          title={t("suggestions.accept.pickLevel", { level })}
                        >
                          <td>
                            <label className="accept-level">
                              <input
                                type="radio"
                                name="accept-level"
                                checked={minConfidence === level}
                                onChange={() => setMinConfidence(level)}
                              />
                              {level}
                            </label>
                          </td>
                          {presentKinds.map((k) => (
                            <td key={k} className="num">
                              {count(k, level) || ""}
                            </td>
                          ))}
                          <td className="num">{candidates.filter((s) => s.confidence === level).length}</td>
                          <td className="num">{atLeast}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {presentKinds.length > 1 && (
                  <div className="accept-kinds">
                    {presentKinds.map((k) => (
                      <label key={k} className="checkbox-row">
                        <input type="checkbox" checked={kinds.has(k)} onChange={() => toggleKind(k)} />
                        <span>{t(`suggestions.kind.${k}`)}</span>
                      </label>
                    ))}
                  </div>
                )}
                <p className="hint">{t("suggestions.accept.hint")}</p>
              </>
            ))}
          {phase !== "choose" && (
            <>
              <progress className="agent-progress" max={chosen.length} value={progress.done} />
              <p>{t("suggestions.accept.progress", { done: progress.done, total: chosen.length, applied: progress.applied })}</p>
              {progress.errors > 0 && (
                <div className="error">
                  {t("suggestions.accept.errors", { count: progress.errors })}
                  {progress.firstError && <> — {progress.firstError}</>}
                </div>
              )}
            </>
          )}
        </div>
        <footer className="modal-footer">
          {phase === "choose" && (
            <>
              <button type="button" className="btn-ghost" onClick={close}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn-primary" disabled={chosen.length === 0} onClick={run}>
                {t("suggestions.accept.apply", { count: chosen.length, level: minConfidence })}
              </button>
            </>
          )}
          {phase === "running" && (
            <button type="button" className="btn-secondary" onClick={() => (stopRef.current = true)}>
              {t("suggestions.run.category.stop")}
            </button>
          )}
          {phase === "done" && (
            <button type="button" className="btn-primary" onClick={onClose}>
              {t("common.close")}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
