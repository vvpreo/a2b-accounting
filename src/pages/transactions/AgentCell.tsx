import { useMemo, useState } from "react";

import { useT } from "../../i18n";
import {
  AgentState,
  aiTransactionChat,
  parseAgentState,
  setTransactionAgent,
  agentReplyText,
} from "../../lib/api";

interface Props {
  transactionId: number;
  /** Raw `Transaction.agent` JSON blob, or null if never run. */
  agent: string | null;
  /** Open the full transaction modal (used when an analysis already exists). */
  onOpen: () => void;
  /** Triggered after a fresh analysis is saved, so the list can refresh. */
  onAnalyzed: () => void;
}

/**
 * Agent column cell. Empty cell → clicking runs the analysis inline and saves
 * it straight to the DB (no separate save step). A cell that already has an
 * analysis shows only the suggested category (+ confidence); the full dialog
 * is available via the hover tooltip, and clicking opens the transaction modal
 * (where the user can read the reasoning, chat further or clear it).
 */
export function AgentCell({ transactionId, agent, onOpen, onAnalyzed }: Props) {
  const t = useT();
  const state = useMemo(() => parseAgentState(agent), [agent]);
  // Tooltip = the whole dialog (verdict YAML block hidden for readability).
  const dialogText = useMemo(
    () =>
      state
        ? state.messages
            .map((m) => agentReplyText(m.content))
            .join("\n\n")
        : "",
    [state],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasAnalysis = state !== null && state.messages.length > 0;

  async function runAnalysis() {
    setBusy(true);
    setError(null);
    try {
      // The analysis is implicit — the system prompt already tells the agent
      // to categorize. We send no user turn (the backend supplies the API's
      // required initial turn internally) and store only the agent's reply,
      // so the chat log never shows a message the user didn't write.
      const reply = await aiTransactionChat(transactionId, []);
      const next: AgentState = {
        suggestedCategory: reply.suggestedCategory,
        confidence: reply.confidence,
        messages: [
          { role: "assistant", content: reply.reply },
        ],
        updatedAt: new Date().toISOString(),
      };
      await setTransactionAgent(transactionId, JSON.stringify(next));
      onAnalyzed();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (hasAnalysis && state) {
    return (
      <td
        className="col-agent txn-open-cell"
        onClick={onOpen}
        title={dialogText || undefined}
      >
        <div className="agent-cell">
          <span className="agent-cell-category">
            {state.suggestedCategory ?? t("transaction.agent.none")}
            {state.confidence !== null && (
              <span className="agent-cell-confidence"> {state.confidence}/10</span>
            )}
          </span>
        </div>
      </td>
    );
  }

  return (
    <td className="col-agent">
      {busy ? (
        <span className="agent-cell-busy">{t("transaction.agent.thinking")}</span>
      ) : (
        <button
          type="button"
          className="agent-cell-run"
          onClick={runAnalysis}
          title={error ?? undefined}
        >
          ✨ {t("transaction.agent.analyze")}
        </button>
      )}
      {error && <span className="agent-cell-error">!</span>}
    </td>
  );
}
