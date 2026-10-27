import { AgentState, aiTransactionChat, setTransactionAgent } from "./api";

/** Run the categorisation agent on one transaction and store its reply as
 *  the transaction's agent state. Shared by the per-row ✨ button and the
 *  bulk "Propose categories" action.
 *
 *  The analysis is implicit — the system prompt already tells the agent to
 *  categorise. No user turn is sent (the backend supplies the API's required
 *  initial turn internally) and only the agent's reply is stored, so the chat
 *  log never shows a message the user didn't write. */
export async function runAgentAnalysis(transactionId: number): Promise<AgentState> {
  const reply = await aiTransactionChat(transactionId, []);
  const next: AgentState = {
    suggestedCategory: reply.suggestedCategory,
    confidence: reply.confidence,
    messages: [{ role: "assistant", content: reply.reply }],
    updatedAt: new Date().toISOString(),
  };
  await setTransactionAgent(transactionId, JSON.stringify(next));
  return next;
}
