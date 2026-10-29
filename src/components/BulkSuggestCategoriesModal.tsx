import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n, useT } from "../i18n";
import {
  AgentOutcome,
  AiConnection,
  Suggestion,
  Transaction,
  getAgentSettings,
  listAiConnections,
  suggestCategory,
} from "../lib/api";
import { findAiPreset } from "../lib/ai-presets";

interface Props {
  /// The selected, currently-visible transactions.
  transactions: Transaction[];
  /// Pending suggestions, to count the selected rows that already have one.
  suggestions: Suggestion[];
  onClose: () => void;
  /// After each new suggestion and at the end, so the table shows them.
  onProgress: () => void;
}

type Phase = "confirm" | "running" | "done";

interface Tally {
  done: number;
  suggested: number;
  skipped: Record<string, number>;
  errors: number;
  firstError: string | null;
  tokens: number;
  ms: number;
}

const EMPTY: Tally = { done: 0, suggested: 0, skipped: {}, errors: 0, firstError: null, tokens: 0, ms: 0 };

/// Bulk "Suggest categories": the category agent, transaction by
/// transaction (progress, Stop). Nothing is applied — suggestions appear in
/// the Suggestion column.
export function BulkSuggestCategoriesModal({ transactions, suggestions, onClose, onProgress }: Props) {
  const t = useT();
  const { locale } = useI18n();
  const [phase, setPhase] = useState<Phase>("confirm");
  const [redo, setRedo] = useState(false);
  const [tally, setTally] = useState<Tally>(EMPTY);
  const [connection, setConnection] = useState<AiConnection | null | undefined>(undefined);
  const stopRef = useRef(false);

  useEffect(() => {
    Promise.all([getAgentSettings(), listAiConnections()]).then(
      ([s, list]) => setConnection(list.find((c) => c.id === s.connectionId) ?? null),
      () => setConnection(null),
    );
  }, []);

  const selected = new Set(transactions.map((x) => x.id));
  const alreadySuggested = new Set(
    suggestions.filter((s) => s.kind === "category" && selected.has(s.transactionId)).map((s) => s.transactionId),
  ).size;

  async function run() {
    setPhase("running");
    stopRef.current = false;
    let acc: Tally = { ...EMPTY, skipped: {} };
    for (const x of transactions) {
      if (stopRef.current) break;
      let outcome: AgentOutcome;
      try {
        outcome = await suggestCategory(x.id, redo);
      } catch (e) {
        outcome = { status: "error", reason: null, error: String(e), categoryId: null, confidence: null, totalTokens: null, durationMs: null };
      }
      acc = {
        ...acc,
        done: acc.done + 1,
        suggested: acc.suggested + (outcome.status === "suggested" ? 1 : 0),
        errors: acc.errors + (outcome.status === "error" ? 1 : 0),
        firstError: acc.firstError ?? (outcome.status === "error" ? outcome.error : null),
        tokens: acc.tokens + (outcome.totalTokens ?? 0),
        ms: acc.ms + (outcome.durationMs ?? 0),
        skipped:
          outcome.status === "skipped" && outcome.reason
            ? { ...acc.skipped, [outcome.reason]: (acc.skipped[outcome.reason] ?? 0) + 1 }
            : acc.skipped,
      };
      setTally(acc);
      // A "not sure" answer also shows up in the Suggestion column.
      if (outcome.status === "suggested" || outcome.reason === "not_confident") onProgress();
      // No connection: every next one would fail the same way.
      if (outcome.error === "agent.no_connection") break;
    }
    onProgress();
    setPhase("done");
  }

  function close() {
    if (phase === "running") return;
    onClose();
  }

  const errorText = (e: string) => (e === "agent.no_connection" ? t("suggestions.run.category.noConnection") : e);
  const skipped = Object.entries(tally.skipped).sort((a, b) => b[1] - a[1]);
  const cloud = connection && findAiPreset(connection.preset)?.requiresApiKey;

  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal modal--bulk-docs" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{t("suggestions.run.category.title")}</h3>
          {phase !== "running" && (
            <button className="icon-btn" onClick={close} aria-label={t("common.close")} type="button">
              ×
            </button>
          )}
        </header>
        <div className="modal-body">
          {phase === "confirm" && (
            <>
              <p>{t("suggestions.run.category.intro", { count: transactions.length })}</p>
              {connection === null ? (
                <div className="error">{t("suggestions.run.category.noConnection")}</div>
              ) : (
                connection && (
                  <p className="hint">
                    {t("suggestions.run.category.via", { name: connection.name, model: connection.model })}
                  </p>
                )
              )}
              {connection?.keyProblem && (
                <div className="error">{t("suggestions.run.category.keyProblem", { message: connection.keyProblem })}</div>
              )}
              {cloud && <p className="hint">{t("settings.agent.cloudWarning")}</p>}
              <p className="hint">{t("suggestions.run.nothingApplied")}</p>
              <label className="checkbox-row">
                <input type="checkbox" checked={redo} onChange={(e) => setRedo(e.target.checked)} />
                <span>{t("suggestions.run.category.redo", { count: alreadySuggested })}</span>
              </label>
            </>
          )}
          {phase !== "confirm" && (
            <>
              <progress className="agent-progress" max={transactions.length} value={tally.done} />
              <p>
                {t("suggestions.run.category.progress", { done: tally.done, total: transactions.length })}
                {" · "}
                {t("suggestions.run.category.result", { count: tally.suggested })}
              </p>
              {skipped.length > 0 && (
                <ul className="suggestion-skips">
                  {skipped.map(([reason, n]) => (
                    <li key={reason}>
                      {t(`suggestions.skip.${reason}`)}: {n}
                    </li>
                  ))}
                </ul>
              )}
              {tally.errors > 0 && (
                <div className="error">
                  {t("suggestions.run.category.errors", { count: tally.errors })}
                  {tally.firstError && <> — {errorText(tally.firstError)}</>}
                </div>
              )}
              {tally.tokens > 0 && (
                <p className="hint">
                  {t("suggestions.run.category.spent", {
                    tokens: tally.tokens.toLocaleString(locale),
                    seconds: Math.round(tally.ms / 1000),
                  })}
                </p>
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
              <button
                type="button"
                className="btn-primary"
                onClick={run}
                disabled={transactions.length === 0 || !connection || !!connection.keyProblem}
              >
                {t("transactions.bulkDocs.start")}
              </button>
            </>
          )}
          {phase === "running" && (
            <button type="button" className="btn-secondary" onClick={() => (stopRef.current = true)}>
              {t("suggestions.run.category.stop")}
            </button>
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
