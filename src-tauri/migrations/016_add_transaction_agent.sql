-- Structured JSON written by the AI agent for a single transaction:
-- suggested category, confidence (0..10), reasoning and the chat history.
-- NULL means the agent has never run on this transaction.
ALTER TABLE transactions ADD COLUMN agent TEXT;
