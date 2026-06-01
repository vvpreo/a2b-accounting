import { useMemo, useState } from "react";

import { useT } from "../i18n";
import {
  AgentState,
  ChatMsg,
  aiTransactionChat,
  parseAgentState,
  setTransactionAgent,
  agentReplyText,
} from "../lib/api";
import { AgentYaml } from "./AgentYaml";

interface Props {
  transactionId: number;
  /** The raw `Transaction.agent` JSON blob, or null if never run. */
  agent: string | null;
  /** Called after the agent state is persisted so the caller can refresh. */
  onChanged?: () => void;
}

/**
 * Chat dialog with the AI agent, scoped to a single transaction. The agent sees
 * every transaction field except the balance (enforced backend-side) plus the
 * category list, and answers in plain text followed by a `---` separator and a
 * small YAML verdict block (category + confidence). The full dialog and the
 * latest verdict are persisted into `transactions.agent` as JSON.
 */
export function AgentSection({ transactionId, agent, onChanged }: Props) {
  const t = useT();

  const initial = useMemo(() => parseAgentState(agent), [agent]);
  const [messages, setMessages] = useState<ChatMsg[]>(initial?.messages ?? []);
  const [verdict, setVerdict] = useState<{
    suggestedCategory: string | null;
    confidence: number | null;
  }>({
    suggestedCategory: initial?.suggestedCategory ?? null,
    confidence: initial?.confidence ?? null,
  });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "json">("chat");

  // Persist + reflect a freshly produced dialog/verdict.
  async function persist(next: ChatMsg[], reply: {
    suggestedCategory: string | null;
    confidence: number | null;
  }) {
    const v = {
      suggestedCategory: reply.suggestedCategory,
      confidence: reply.confidence,
    };
    setMessages(next);
    setVerdict(v);
    setInput("");
    const state: AgentState = {
      ...v,
      messages: next,
      updatedAt: new Date().toISOString(),
    };
    await setTransactionAgent(transactionId, JSON.stringify(state));
    onChanged?.();
  }

  // Continue the conversation with a user message (chat input).
  async function send(userMessage: string) {
    setBusy(true);
    setError(null);
    const outgoing: ChatMsg[] = [
      ...messages,
      { role: "user", content: userMessage },
    ];
    try {
      const reply = await aiTransactionChat(transactionId, outgoing);
      await persist(
        [...outgoing, { role: "assistant", content: reply.reply }],
        reply,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Run a fresh analysis from scratch: discard any prior dialog/verdict and
  // start over (the "Analyze" button). The agent receives no prior context.
  async function runFresh() {
    setBusy(true);
    setError(null);
    try {
      const reply = await aiTransactionChat(transactionId, []);
      await persist(
        [{ role: "assistant", content: reply.reply }],
        reply,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function submitInput() {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    void send(trimmed);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitInput();
  }

  // Enter sends, Shift+Enter inserts a newline (standard chat behaviour).
  function onInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitInput();
    }
  }

  async function clearAnalysis() {
    setBusy(true);
    setError(null);
    try {
      await setTransactionAgent(transactionId, null);
      setMessages([]);
      setVerdict({
        suggestedCategory: null,
        confidence: null,
      });
      setInput("");
      setView("chat");
      onChanged?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const hasVerdict =
    verdict.suggestedCategory !== null || verdict.confidence !== null;
  const hasAnything = hasVerdict || messages.length > 0;

  return (
    <div className="txn-agent">
      <div className="txn-agent-header">
        <span className="txn-field-label">{t("transaction.agent.title")}</span>
        <div className="txn-agent-actions">
          {hasAnything && (
            <button
              type="button"
              className="btn-ghost btn-small"
              onClick={() => setView(view === "chat" ? "json" : "chat")}
            >
              {view === "chat"
                ? t("transaction.agent.showJson")
                : t("transaction.agent.showChat")}
            </button>
          )}
          {hasAnything && (
            <button
              type="button"
              className="btn-ghost btn-small"
              onClick={() => void clearAnalysis()}
              disabled={busy}
            >
              {t("transaction.agent.clear")}
            </button>
          )}
          <button
            type="button"
            className="btn-ghost btn-small"
            onClick={() => void runFresh()}
            disabled={busy}
          >
            {busy
              ? t("transaction.agent.thinking")
              : t("transaction.agent.analyze")}
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {view === "json" ? (
        <AgentYaml
          state={{
            suggestedCategory: verdict.suggestedCategory,
            confidence: verdict.confidence,
            messages,
          }}
        />
      ) : (
        <>
          {hasVerdict ? (
            <div className="txn-agent-verdict">
              <div className="txn-agent-verdict-row">
                <span className="txn-field-label">
                  {t("transaction.agent.suggested")}
                </span>
                <span className="txn-agent-category">
                  {verdict.suggestedCategory ?? t("transaction.agent.none")}
                </span>
                <span className="txn-agent-confidence">
                  {t("transaction.agent.confidence")}:{" "}
                  {verdict.confidence ?? "—"}/10
                </span>
              </div>
            </div>
          ) : (
            messages.length === 0 && (
              <p className="settings-hint">{t("transaction.agent.empty")}</p>
            )
          )}

          {messages.length > 0 && (
            <div className="txn-agent-log">
              {messages.map((m, i) => (
                <AgentMessage key={i} msg={m} />
              ))}
            </div>
          )}

          <form className="txn-agent-input" onSubmit={onSubmit}>
            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder={t("transaction.agent.placeholder")}
              disabled={busy}
            />
            <button
              type="submit"
              className="btn-secondary btn-small"
              disabled={busy || input.trim() === ""}
            >
              {t("transaction.agent.send")}
            </button>
          </form>
        </>
      )}
    </div>
  );
}

/** One chat bubble. For assistant turns the verdict marker lines are hidden for
 *  a clean read (the full text is still stored and shown in the YAML view). */
function AgentMessage({ msg }: { msg: ChatMsg }) {
  const text =
    msg.role === "assistant" ? agentReplyText(msg.content) : msg.content;
  return (
    <div
      className={
        "txn-agent-msg txn-agent-msg--" +
        (msg.role === "user" ? "user" : "assistant")
      }
    >
      <div className="txn-agent-msg-content">{text}</div>
    </div>
  );
}
