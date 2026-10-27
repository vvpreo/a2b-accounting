import { useMemo, useState } from "react";

import { useT } from "../../i18n";
import { parseAgentState, agentReplyText } from "../../lib/api";
import { runAgentAnalysis } from "../../lib/agent-run";

interface Props {
  transactionId: number;
  /** Raw `Transaction.agent` JSON blob, or null if never run. */
  agent: string | null;
  /** Open the full transaction modal (used when an analysis already exists). */
  onOpen: () => void;
  /** Triggered after a fresh analysis is saved, so the list can refresh. */
  onAnalyzed: () => void;
  /** The note recognised on the linked document (slip), if any. */
  memo?: string | null;
}

/**
 * Agent column cell, one line: a ✨ button that runs the analysis inline and
 * saves it straight to the DB, or — once analysed — a chip with the suggested
 * category (+ confidence) whose tooltip is the full dialog and whose click
 * opens the transaction modal; followed by the note recognised on the linked
 * slip, if any.
 */
export function AgentCell({ transactionId, agent, onOpen, onAnalyzed, memo }: Props) {
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
      await runAgentAnalysis(transactionId);
      onAnalyzed();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // One line per row: a compact action/verdict slot on the left (so the ✨
  // buttons line up down the column), the slip's note filling the rest.
  // Rows without a note show only the faint ✨ — notes stand out at a glance.
  const slot =
    hasAnalysis && state ? (
      <button
        type="button"
        className="agent-cell-verdict"
        onClick={onOpen}
        title={dialogText || undefined}
      >
        {state.suggestedCategory ?? t("transaction.agent.none")}
        {state.confidence !== null && (
          <span className="agent-cell-confidence"> {state.confidence}/10</span>
        )}
      </button>
    ) : busy ? (
      <span className="agent-cell-busy" title={t("transaction.agent.thinking")}>
        …
      </span>
    ) : (
      <button
        type="button"
        className="agent-cell-run"
        onClick={runAnalysis}
        title={error ?? t("transaction.agent.analyze")}
        aria-label={t("transaction.agent.analyze")}
      >
        ✨
      </button>
    );

  return (
    <td className="col-agent">
      <div className="agent-cell">
        {slot}
        {error && (
          <span className="agent-cell-error" title={error}>
            !
          </span>
        )}
        {memo && <MemoLine memo={memo} />}
      </div>
    </td>
  );
}

/** The user's note from the linked slip — the main input for categorising. */
function MemoLine({ memo }: { memo: string }) {
  return (
    <span className="agent-cell-memo" title={memo}>
      📝 {memo}
    </span>
  );
}
