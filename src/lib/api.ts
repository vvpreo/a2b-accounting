/// Minimal RPC bridge to the backend: `POST /api/rpc/<cmd>` with a JSON args
/// object. Mirrors the former Tauri `invoke` contract — resolves with the
/// command's JSON result, rejects with the backend's error *string* (often a
/// stable code the UI localises), so existing `catch (e) { String(e) }`
/// call sites keep working unchanged.
async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`/api/rpc/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  if (!res.ok) {
    throw await res.text();
  }
  return (await res.json()) as T;
}

export type AccountKind = "bank" | "cash";

export interface Account {
  id: number;
  name: string;
  /** Distinguishes statement-imported accounts ("bank") from manually-entered
   *  ones ("cash"). Optional in the type for forward-compat with payloads
   *  produced before the field was added; treat missing as "bank". */
  kind: AccountKind;
  bank: string;
  currency: string;
  /** Nullable: cash accounts have no real account number. */
  accountNumber: string | null;
  /** Nullable: cash accounts have no owner-name field. */
  ownerName: string | null;
  createdAt: string;
}

export interface Transaction {
  id: number;
  accountId: number;
  /** `null` for manually-entered cash transactions. */
  importBatchId: number | null;
  occurredAtUtc: string;
  credit: string;
  debit: string;
  balance: string;
  peer: string | null;
  bankDescription: string | null;
  comment: string | null;
  isCorrecting: boolean;
}

export type CategoryKind = "income" | "expense";

export interface Category {
  id: number;
  name: string;
  color: string;
  kind: CategoryKind;
  parentId: number | null;
  description: string | null;
  createdAt: string;
}

export interface ImportBatch {
  id: number;
  accountId: number;
  importedAt: string;
  sourceFilename: string | null;
  rowCount: number;
  timezoneOffset: string;
}

export interface ValidationError {
  txnId: number;
  expectedBalance: string;
  actualBalance: string;
  occurredAtUtc: string;
  bankDescription: string | null;
  comment: string | null;
}

export interface ImportResult {
  batchId: number;
  inserted: number;
  correctionsInserted: number;
  validationErrors: ValidationError[];
}

export type PreviewRowIssueKind =
  | "balance_db"
  | "balance_file"
  | "duplicate_db"
  | "duplicate_file";

export interface PreviewRowIssue {
  rowIndex: number;
  kind: PreviewRowIssueKind;
  expectedBalance: string | null;
  actualBalance: string | null;
}

export interface ImportPreviewValidation {
  rowIssues: PreviewRowIssue[];
}

export interface TxnImportRow {
  occurredAt: string;
  credit: string;
  debit: string;
  balance: string;
  peer: string | null;
  bankDescription: string | null;
  comment: string | null;
}

export function dataDir(): Promise<string> {
  return invoke<string>("data_dir");
}

/// Snapshot of where the server keeps the DB and how that path was decided.
/// `source` values: `"env"` (FINANCES_DATA_DIR env var — the normal mode in
/// Docker/dev) or `"default"` (per-user fallback path). Display-only in the
/// web build; `defaultPath` mirrors `path` and is kept for compatibility.
export interface DataDirInfo {
  path: string;
  defaultPath: string;
  source: "default" | "env";
  envOverride: boolean;
}

export function dataDirInfo(): Promise<DataDirInfo> {
  return invoke<DataDirInfo>("data_dir_info");
}

/// Download the current DB (after a WAL checkpoint) as a single-entry ZIP.
/// Resolves with the blob plus the server-suggested filename; the caller
/// hands both to `triggerDownload`. Rejects with the backend error string.
export async function fetchBackupBlob(): Promise<{
  blob: Blob;
  filename: string;
}> {
  const res = await fetch("/api/backup");
  if (!res.ok) {
    throw await res.text();
  }
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return {
    blob: await res.blob(),
    filename: match?.[1] ?? "finances-backup.zip",
  };
}

/// Browser-download helper: saves a blob under the given filename via a
/// transient anchor element. Replaces the desktop build's save dialog.
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/// Upload a backup ZIP and install it. The backend validates the archive
/// (valid SQLite with our `schema_migrations` table), renames the current
/// `finances.db` to `finances.db.bak-<utc-timestamp>`, installs the new file
/// and reopens the DB in-process. Caller reloads the page afterwards.
export async function restoreFromZip(file: File): Promise<void> {
  const res = await fetch("/api/restore", { method: "POST", body: file });
  if (!res.ok) {
    throw await res.text();
  }
}

export function createAccount(args: {
  name: string;
  kind?: AccountKind;
  bank: string;
  currency: string;
  accountNumber: string | null;
  ownerName: string | null;
}): Promise<Account> {
  return invoke<Account>("create_account", args);
}

export function listAccounts(): Promise<Account[]> {
  return invoke<Account[]>("list_accounts");
}

/** Persist the user's account order: `ids` is the full list in the new
 *  order. `listAccounts` (and every account list in the app) follows it. */
export function reorderAccounts(ids: number[]): Promise<void> {
  return invoke<void>("reorder_accounts", { ids });
}

export function updateAccount(args: {
  id: number;
  name: string;
  kind?: AccountKind;
  bank: string;
  currency: string;
  accountNumber: string | null;
  ownerName: string | null;
}): Promise<Account> {
  return invoke<Account>("update_account", args);
}

export function deleteAccount(id: number): Promise<void> {
  return invoke<void>("delete_account", { id });
}

export function createCategory(args: {
  name: string;
  color: string;
  kind: CategoryKind;
  parentId: number | null;
  description: string | null;
}): Promise<Category> {
  return invoke<Category>("create_category", args);
}

export function listCategories(): Promise<Category[]> {
  return invoke<Category[]>("list_categories");
}

export function updateCategory(args: {
  id: number;
  name: string;
  color: string;
  description: string | null;
  parentId: number | null;
}): Promise<Category> {
  return invoke<Category>("update_category", args);
}

export function deleteCategory(id: number): Promise<void> {
  return invoke<void>("delete_category", { id });
}

export interface TransactionCategoryView {
  transactionId: number;
  categoryId: number;
  shareMinor: number;
  position: number;
  categoryName: string;
  categoryColor: string;
  categoryKind: CategoryKind;
}

export interface TransactionCategoryItem {
  categoryId: number;
  shareMinor: number;
  position: number;
}

export function setTransactionCategories(args: {
  transactionId: number;
  items: TransactionCategoryItem[];
}): Promise<void> {
  return invoke<void>("set_transaction_categories", args);
}

export function listTransactionsCategories(
  accountIds?: number[],
): Promise<TransactionCategoryView[]> {
  return invoke<TransactionCategoryView[]>("list_transactions_categories", {
    accountIds: accountIds && accountIds.length > 0 ? accountIds : null,
  });
}

export interface TxnLink {
  id: number;
  txnAId: number;
  txnBId: number;
}

// Stable error codes returned by `link_transactions` so the UI can localise.
export type LinkErrorCode =
  | "link.txn_not_found"
  | "link.same_txn"
  | "link.same_account"
  | "link.same_direction"
  | "link.already_linked";

export const LINK_ERROR_CODES: LinkErrorCode[] = [
  "link.txn_not_found",
  "link.same_txn",
  "link.same_account",
  "link.same_direction",
  "link.already_linked",
];

export function listTransactionLinks(
  accountIds?: number[],
): Promise<TxnLink[]> {
  return invoke<TxnLink[]>("list_transaction_links", {
    accountIds: accountIds && accountIds.length > 0 ? accountIds : null,
  });
}

export function linkTransactions(aId: number, bId: number): Promise<TxnLink> {
  return invoke<TxnLink>("link_transactions", { aId, bId });
}

export function unlinkTransaction(transactionId: number): Promise<void> {
  return invoke<void>("unlink_transaction", { transactionId });
}

/// FX-conversion gain/loss for one side of an inter-account transfer.
/// `deltaMinor` is the signed amount in the transaction's own currency, in
/// minor units (cents/satang/...). `null` when the dictionary rate isn't
/// available yet — the UI then renders a red dash. `expectedMinor` is the
/// absolute amount this side *should* have moved at the fair cross-rate;
/// it acts as the percentage base in the UI's % display. `rateDate` is the
/// actual date of the rate row that backed the calculation; `null` for
/// EUR/EUR transfers (EUR is the base — no row to point at).
export interface TransferDelta {
  transactionId: number;
  deltaMinor: number | null;
  expectedMinor: number | null;
  currency: string;
  rateDate: string | null;
}

export function listTransferDeltas(): Promise<TransferDelta[]> {
  return invoke<TransferDelta[]>("list_transfer_deltas");
}

export function importTransactions(args: {
  accountId: number;
  sourceFilename: string | null;
  defaultTimezoneOffset: string;
  rows: TxnImportRow[];
}): Promise<ImportResult> {
  return invoke<ImportResult>("import_transactions", args);
}

export function listTransactions(
  accountIds?: number[],
): Promise<Transaction[]> {
  return invoke<Transaction[]>("list_transactions", {
    accountIds: accountIds && accountIds.length > 0 ? accountIds : null,
  });
}

export function firstTransactionDate(
  accountIds?: number[],
): Promise<string | null> {
  return invoke<string | null>("first_transaction_date", {
    accountIds: accountIds && accountIds.length > 0 ? accountIds : null,
  });
}

export function listImportBatches(accountId: number): Promise<ImportBatch[]> {
  return invoke<ImportBatch[]>("list_import_batches", { accountId });
}

export function deleteImportBatch(batchId: number): Promise<void> {
  return invoke<void>("delete_import_batch", { batchId });
}

export function validateBalanceChain(
  accountId: number,
): Promise<ValidationError[]> {
  return invoke<ValidationError[]>("validate_balance_chain", { accountId });
}

export type AccountMonthStatus = "pre_account" | "no_data" | "complete";

export interface AccountMonthCell {
  accountId: number;
  yearMonth: string;
  status: AccountMonthStatus;
  balanceError: boolean;
  uncategorizedCorrecting: boolean;
  /** True if any transaction exists strictly later than this month — the
   *  chain "closes" past this point. Drives the black anchor border. */
  anchored: boolean;
}

export interface AccountLatestTransaction {
  accountId: number;
  /** UTC ISO timestamp. */
  occurredAtUtc: string;
  /** Timezone offset string ("+03:00" etc.) of the source import batch. */
  timezoneOffset: string;
  /** Net amount, decimal-formatted, signed (positive = credit). */
  amountMinor: string;
}

export function latestTransactions(): Promise<AccountLatestTransaction[]> {
  return invoke<AccountLatestTransaction[]>("latest_transactions");
}

export interface MonthRange {
  yearMonth: string;
  startUtc: string;
  endUtc: string;
}

export function accountMonthlyStatus(
  months: MonthRange[],
): Promise<AccountMonthCell[]> {
  return invoke<AccountMonthCell[]>("account_monthly_status", { months });
}

/// Per-account, per-month rollup that powers the optional "Сводка" strip
/// rows on the Accounts page. All counters and amounts already exclude
/// internal-transfer transactions (those that have a row in
/// `transaction_links`); the frontend just turns them into percentages.
///
/// Money fields are formatted-decimal strings ("123.45") — same convention
/// as `Transaction.credit` / `Transaction.debit`. Parse with `Number()` for
/// the percent calculation.
export interface AccountMonthSummary {
  accountId: number;
  yearMonth: string;
  incomeTotalCount: number;
  incomeCategorizedCount: number;
  incomeTotalMinor: string;
  incomeCategorizedShareMinor: string;
  expenseTotalCount: number;
  expenseCategorizedCount: number;
  expenseTotalMinor: string;
  expenseCategorizedShareMinor: string;
}

export function accountMonthlySummaryStats(
  months: MonthRange[],
): Promise<AccountMonthSummary[]> {
  return invoke<AccountMonthSummary[]>("account_monthly_summary_stats", {
    months,
  });
}

/// "in" → goes to `credit`, "out" → goes to `debit`. The form picks the
/// direction with a segmented control; the backend splits the amount across
/// credit/debit.
export type CashDirection = "in" | "out";

export interface CashTransactionInput {
  accountId: number;
  occurredAtUtc: string;
  direction: CashDirection;
  /** Decimal-formatted amount in major units ("123.45"). */
  amount: string;
  peer: string | null;
  comment: string | null;
}

export function createCashTransaction(
  args: CashTransactionInput,
): Promise<Transaction> {
  return invoke<Transaction>("create_cash_transaction", { ...args });
}

export interface CashTransactionUpdate {
  id: number;
  occurredAtUtc: string;
  direction: CashDirection;
  amount: string;
  peer: string | null;
  comment: string | null;
}

export function updateCashTransaction(
  args: CashTransactionUpdate,
): Promise<Transaction> {
  return invoke<Transaction>("update_cash_transaction", { ...args });
}

export function deleteCashTransaction(id: number): Promise<void> {
  return invoke<void>("delete_cash_transaction", { id });
}

// Stable error codes from `create_cash_withdrawal` and friends. The
// `link.*` codes reuse the existing pairing errors when a withdrawal
// hits the same invariants (already linked, same account).
export type WithdrawalErrorCode =
  | "withdrawal.source_not_outgoing"
  | "withdrawal.account_not_cash"
  | "withdrawal.invalid_amount"
  | "withdrawal.rate_unavailable";

export const WITHDRAWAL_ERROR_CODES: WithdrawalErrorCode[] = [
  "withdrawal.source_not_outgoing",
  "withdrawal.account_not_cash",
  "withdrawal.invalid_amount",
  "withdrawal.rate_unavailable",
];

export interface CashWithdrawalResult {
  newTransaction: Transaction;
  link: TxnLink;
}

export function createCashWithdrawal(args: {
  sourceTxnId: number;
  cashAccountId: number;
  amount: string;
}): Promise<CashWithdrawalResult> {
  return invoke<CashWithdrawalResult>("create_cash_withdrawal", { ...args });
}

export function updateTransactionComment(
  id: number,
  comment: string | null,
): Promise<void> {
  return invoke<void>("update_transaction_comment", { id, comment });
}

/// Outcome of a bulk field-update run (CSV re-import in "update fields" mode).
/// Every parsed row falls into exactly one bucket.
export interface BulkUpdateResult {
  updated: number;
  unmatched: number;
  ambiguous: number;
}

/// Bulk-update the descriptive fields (peer, bank_description, comment) of
/// existing transactions from a re-imported CSV. Matches each row to a stored
/// transaction by its (occurred_at, credit, debit, balance) key and fully
/// overwrites all three fields from the row — including blanks, which clear the
/// stored value (snapshot semantics). Amounts/dates are untouched; no import
/// batch is created.
export function bulkUpdateTransactionFields(args: {
  accountId: number;
  defaultTimezoneOffset: string;
  rows: TxnImportRow[];
}): Promise<BulkUpdateResult> {
  return invoke<BulkUpdateResult>("bulk_update_transaction_fields", args);
}

// Fetch a single transaction by id (for the per-transaction view/edit modal).
export function getTransaction(id: number): Promise<Transaction> {
  return invoke<Transaction>("get_transaction", { id });
}

// Update the free-text fields of any transaction (bank or cash). Safe on
// imported statement rows — does not touch amounts/date/balance. Returns the
// refreshed transaction.
export function updateTransactionFields(args: {
  id: number;
  peer: string | null;
  bankDescription: string | null;
  comment: string | null;
}): Promise<Transaction> {
  return invoke<Transaction>("update_transaction_fields", args);
}

export function validateImportPreview(args: {
  accountId: number;
  defaultTimezoneOffset: string;
  rows: TxnImportRow[];
}): Promise<ImportPreviewValidation> {
  return invoke<ImportPreviewValidation>("validate_import_preview", args);
}

export function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("get_setting", { key });
}

export function setSetting(key: string, value: string): Promise<void> {
  return invoke<void>("set_setting", { key, value });
}

// ---- AI connections and the category agent (server/src/ai.rs, category_agent.rs) ----

export type AiProtocol = "openai" | "anthropic";

/** One LLM connection, created from a preset (`src/lib/ai-presets.ts`).
 *  `apiKey` may be a literal key or an `env:VAR_NAME` reference resolved by
 *  the backend from the process environment. */
export interface AiConnection {
  /** 0 for a connection not saved yet. */
  id: number;
  name: string;
  preset: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number | null;
  /** Why the key cannot be used right now (e.g. an unset `env:` variable);
   *  computed by the server, ignored when saving. */
  keyProblem?: string | null;
}

export function listAiConnections(): Promise<AiConnection[]> {
  return invoke<AiConnection[]>("list_ai_connections");
}

/** Create (`id === 0`) or update; returns the id. */
export function saveAiConnection(connection: AiConnection): Promise<number> {
  return invoke<number>("save_ai_connection", { connection });
}

export function deleteAiConnection(id: number): Promise<void> {
  return invoke<void>("delete_ai_connection", { id });
}

/** Send a tiny prompt through a saved connection. Returns a short summary
 *  (model + reply snippet). */
export function aiTestConnection(id: number): Promise<string> {
  return invoke<string>("ai_test_connection", { id });
}

export interface AgentSettings {
  connectionId: number | null;
  /** The user's instructions in the system prompt. */
  instructions: string;
  defaultInstructions: string;
  examplesPerCategory: number;
  autoExamples: boolean;
  /** Answers below this confidence (0–10) are not offered. */
  minConfidence: number;
}

export function getAgentSettings(): Promise<AgentSettings> {
  return invoke<AgentSettings>("get_agent_settings");
}

export function saveAgentSettings(s: Omit<AgentSettings, "defaultInstructions">): Promise<void> {
  return invoke<void>("save_agent_settings", {
    connectionId: s.connectionId,
    instructions: s.instructions,
    examplesPerCategory: s.examplesPerCategory,
    autoExamples: s.autoExamples,
    minConfidence: s.minConfidence,
  });
}

/** One transaction through the category agent. */
export interface AgentOutcome {
  status: "suggested" | "skipped" | "error";
  /** Skip reason code (`suggestions.skip.*`). */
  reason: string | null;
  error: string | null;
  categoryId: number | null;
  confidence: number | null;
  totalTokens: number | null;
  durationMs: number | null;
}

export function suggestCategory(transactionId: number, redo: boolean): Promise<AgentOutcome> {
  return invoke<AgentOutcome>("suggest_category", { transactionId, redo });
}

/** Mark / unmark transactions as examples for the agent; only categorised
 *  ones can be examples. Returns how many changed. */
export function setCategoryExamples(transactionIds: number[], example: boolean): Promise<number> {
  return invoke<number>("set_category_examples", { transactionIds, example });
}

export function listCategoryExamples(): Promise<number[]> {
  return invoke<number[]>("list_category_examples");
}

/** What says a category's examples may not be enough (see
 *  `category_agent.rs::examples_report`). */
export type ExamplesIssue = "no_examples" | "few_examples" | "agent_misses" | "conflicts";

/** A counterparty of the category that is also in other categories. */
export interface PeerConflict {
  peer: string;
  /** Its transactions in this category, newest first. */
  here: number[];
  elsewhere: { categoryId: number; transactions: number[] }[];
  /** One of `here` is marked as an example. */
  resolved: boolean;
}

export interface CategoryExamplesReport {
  categoryId: number;
  /** Categorised transactions, newest first. */
  labeled: number[];
  /** Distinct counterparties among them. */
  peers: number;
  /** Marked by the user, newest first; the agent shows them all. */
  marked: number[];
  /** Picked automatically to fill up to N. */
  auto: number[];
  conflicts: PeerConflict[];
  /** The agent suggested this category and it was right. */
  agentHits: number;
  /** Transactions of this category for which the agent suggested another one. */
  agentMisses: { transactionId: number; suggestedCategoryId: number }[];
  /** The agent suggested this category, but it was another one / dismissed. */
  agentFalse: number;
  issues: ExamplesIssue[];
}

export interface ExamplesReport {
  examplesPerCategory: number;
  autoExamples: boolean;
  categories: CategoryExamplesReport[];
}

export function categoryExamplesReport(): Promise<ExamplesReport> {
  return invoke<ExamplesReport>("category_examples_report");
}

export interface TokenUsageRow {
  connectionName: string | null;
  model: string | null;
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  durationMs: number;
  lastAt: string;
}

export function agentTokenUsage(): Promise<TokenUsageRow[]> {
  return invoke<TokenUsageRow[]>("agent_token_usage");
}

/** The agent log (every model call with the full exchange, every user
 *  decision) as JSON — for building evals. */
export function exportAgentLog(): Promise<unknown> {
  return invoke<unknown>("export_agent_log");
}

// ---- Life context (server/src/life_contexts.rs) ----

/** A date interval of what was going on in life (a trip, an illness, …).
 *  Days are `YYYY-MM-DD`, both bounds inclusive; intervals may overlap. */
export interface LifeContext {
  id: number;
  title: string;
  startsOn: string;
  endsOn: string;
  color: string;
  note: string | null;
  createdAt: string;
}

export interface LifeContextInput {
  title: string;
  startsOn: string;
  endsOn: string;
  color: string;
  note: string | null;
}

export function listLifeContexts(): Promise<LifeContext[]> {
  return invoke<LifeContext[]>("list_life_contexts");
}

export function createLifeContext(args: LifeContextInput): Promise<LifeContext> {
  return invoke<LifeContext>("create_life_context", { ...args });
}

export function updateLifeContext(args: LifeContextInput & { id: number }): Promise<LifeContext> {
  return invoke<LifeContext>("update_life_context", { ...args });
}

export function deleteLifeContext(id: number): Promise<void> {
  return invoke<void>("delete_life_context", { id });
}

// ---- Suggestions (server/src/suggestions.rs) ----

export type SuggestionKind = "category" | "transfer" | "cash_withdrawal";

/** A pending suggestion on what to do with a transaction. Nothing is applied
 *  until `applySuggestion`; existing categories and links are never changed
 *  by the suggestion pipeline itself. */
export interface Suggestion {
  id: number;
  transactionId: number;
  kind: SuggestionKind;
  source: "llm" | "rule" | "history";
  categoryId: number | null;
  /** The other side of a suggested transfer (stored on both sides). */
  partnerTxnId: number | null;
  /** Where a suggested cash withdrawal goes. */
  cashAccountId: number | null;
  /** 0..10. */
  confidence: number;
  /** Why the confidence is what it is. */
  rationale: string;
  /** The model's own reasoning, when it returned any. */
  reasoning: string | null;
  /** Exactly what was sent to the model. */
  prompt: string | null;
  model: string | null;
  createdAt: string;
}

/** Outcome of a bulk detection run: suggestions made and skip reasons
 *  (codes localised under `suggestions.skip.*`) with their counts. */
export interface SuggestionRunSummary {
  suggested: number;
  skipped: Record<string, number>;
}

export function detectCashWithdrawals(
  transactionIds: number[],
  redo: boolean,
): Promise<SuggestionRunSummary> {
  return invoke<SuggestionRunSummary>("detect_cash_withdrawals", { transactionIds, redo });
}

export function detectTransfers(
  transactionIds: number[],
  redo: boolean,
): Promise<SuggestionRunSummary> {
  return invoke<SuggestionRunSummary>("detect_transfers", { transactionIds, redo });
}

export function listTransactionSuggestions(): Promise<Suggestion[]> {
  return invoke<Suggestion[]>("list_transaction_suggestions");
}

export function applySuggestion(id: number): Promise<void> {
  return invoke<void>("apply_suggestion", { id });
}

export function dismissSuggestion(id: number): Promise<void> {
  return invoke<void>("dismiss_suggestion", { id });
}

/** The selected transactions as a reference set (JSON) for evaluating models
 *  and rules — model context without the balance, the user's own answer and
 *  the transfer-window neighbours. */
export function exportReferenceSet(transactionIds: number[]): Promise<unknown> {
  return invoke<unknown>("export_reference_set", { transactionIds });
}

export interface Currency {
  code: string;
  name: string;
  symbol: string;
  /// Source of conversion rates for this currency (e.g. "frankfurter").
  /// `null` means no automatic rate feed is wired up.
  rateSource: string | null;
}

export function listCurrencies(): Promise<Currency[]> {
  return invoke<Currency[]>("list_currencies");
}

export interface ExchangeRate {
  id: number;
  currency: string;
  rateDate: string;
  rateToBase: string;
  createdAt: string;
}

export function listExchangeRates(): Promise<ExchangeRate[]> {
  return invoke<ExchangeRate[]>("list_exchange_rates");
}

export function upsertExchangeRate(args: {
  currency: string;
  rateDate: string;
  rateToBase: string;
}): Promise<ExchangeRate> {
  return invoke<ExchangeRate>("upsert_exchange_rate", args);
}

export function deleteExchangeRate(id: number): Promise<void> {
  return invoke<void>("delete_exchange_rate", { id });
}

/// Convert `amount` from `fromCurrency` into `toCurrency` using the rate that
/// would have been active on `dateYyyyMmDd`. Same-currency conversions
/// short-circuit to the original amount. Returns a decimal string with two
/// fractional digits ready to be displayed or sent into createCashWithdrawal.
/// Rejects with the stable code `"withdrawal.rate_unavailable"` when either
/// currency has no rate on or near the requested date.
export function convertAmount(args: {
  amount: string;
  fromCurrency: string;
  toCurrency: string;
  dateYyyyMmDd: string;
}): Promise<string> {
  return invoke<string>("convert_amount", { ...args });
}

export interface CurrencyRateSummary {
  code: string;
  name: string;
  symbol: string;
  rateSource: string | null;
  rateCount: number;
  earliestDate: string;
  latestDate: string;
}

export function listCurrencyRateSummaries(): Promise<CurrencyRateSummary[]> {
  return invoke<CurrencyRateSummary[]>("list_currency_rate_summaries");
}

export interface RateEntry {
  rateDate: string;
  rateToBase: string;
}

export function listRateEntriesForCurrency(
  currency: string,
): Promise<RateEntry[]> {
  return invoke<RateEntry[]>("list_rate_entries_for_currency", { currency });
}

export function downloadRatesForCurrency(currency: string): Promise<number> {
  return invoke<number>("download_rates_for_currency", { currency });
}

export type Granularity = "year" | "quarter" | "month";

export type RangePreset =
  | "current_month"
  | "current_quarter"
  | "current_year"
  | "last_12_months"
  | "all_time"
  | "custom";

export type ReportRange =
  | { kind: "preset"; preset: Exclude<RangePreset, "custom"> }
  | { kind: "custom"; from: string; to: string };

// Metric rows the user can toggle on/off in the report's "Метрики" section.
// Persisted in ReportConfig.visibleMetrics; missing field falls back to all
// keys enabled (matching the default UX for both new and legacy reports).
// Adding a new key is backwards-compatible: legacy configs that listed only
// the original four keys keep their selection literally — the new metrics
// stay hidden until the user opts in via the gear-modal.
export type MetricKey =
  | "net"
  | "cumulative"
  | "opening"
  | "closing"
  | "internalTransferOut"
  | "internalTransferIn";

export const ALL_METRIC_KEYS: MetricKey[] = [
  "net",
  "cumulative",
  "opening",
  "closing",
  "internalTransferOut",
  "internalTransferIn",
];

export interface ReportConfig {
  version: 1;
  accountIds: number[];
  expenseCategoryIds: number[];
  incomeCategoryIds: number[];
  // Full DFS display order of every category present at save time, including
  // unchecked ones — lets the builder preserve a user's reorder for items
  // that aren't currently selected. Optional for backwards compatibility.
  expenseCategoryOrder?: number[];
  incomeCategoryOrder?: number[];
  // Legacy: kept optional so old saved views still parse. The backend now
  // always shows the "Без категории" row whenever it has any amount, so this
  // flag is ignored on read.
  expenseShowUncategorized?: boolean;
  incomeShowUncategorized?: boolean;
  defaultRange: ReportRange;
  defaultGranularity: Granularity;
  expandedCategoryIds: number[];
  // Persisted runtime preference: hide/show the trailing "Итого" column.
  // Optional for backwards compatibility with older saved configs.
  showTotalColumn?: boolean;
  // When true, income/expense rows whose every per-period value AND total
  // are zero are kept in the rendered pivot; when false they're dropped.
  // Metrics rows are not affected — they're controlled via `visibleMetrics`.
  // Optional; missing field defaults to `false` (hide zero rows), which is
  // the default UX.
  showZeroRows?: boolean;
  /**
   * @deprecated Legacy field — superseded by `showZeroRows` (inverted
   * meaning). Reader inverts and falls back when `showZeroRows` is absent;
   * writer no longer emits this key.
   */
  hideZeroRows?: boolean;
  // Subset of MetricKey values to render in the "Метрики" section. When
  // omitted (older configs), the renderer falls back to ALL_METRIC_KEYS.
  visibleMetrics?: MetricKey[];
}

export interface ReportView {
  id: number;
  name: string;
  config: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export function listReportViews(): Promise<ReportView[]> {
  return invoke<ReportView[]>("list_report_views");
}

export function updateReportView(args: {
  id: number;
  name: string;
  config: string;
}): Promise<ReportView> {
  return invoke<ReportView>("update_report_view", args);
}

export interface ReportRequest {
  accountIds: number[];
  expenseCategoryIds: number[];
  incomeCategoryIds: number[];
  from: string;
  to: string;
  granularity: Granularity;
}

export interface PeriodColumn {
  key: string;
  label: string;
}

export interface ReportRow {
  categoryId: number | null;
  name: string;
  color: string;
  depth: number;
  values: string[];
  total: string;
}

export interface SectionData {
  rows: ReportRow[];
  total: string[];
}

export interface BalanceMetrics {
  // Per-period sum of opening balances across selected accounts. Each value is
  // a money string (same format as ReportRow.values).
  opening: string[];
  closing: string[];
}

export interface InternalTransferMetrics {
  // Per-period money strings for transactions that the paired-link rule
  // removed from income/expense — outflows = debit side, inflows = credit
  // side. Both arrays have one entry per period.
  outflows: string[];
  inflows: string[];
}

export interface ReportResponse {
  periods: PeriodColumn[];
  expense: SectionData;
  income: SectionData;
  balances: BalanceMetrics;
  internalTransfers: InternalTransferMetrics;
}

export function computeReport(request: ReportRequest): Promise<ReportResponse> {
  return invoke<ReportResponse>("compute_report", { request });
}

// Drill-down: which report cell the user clicked. The backend replays the same
// aggregation as `compute_report` for this single cell, so the returned shares
// sum to the displayed value.
export interface CellTarget {
  section: "income" | "expense";
  // null => the "Без категории" row.
  categoryId: number | null;
  // true for a group row (parent + selected descendants); false for a leaf/own
  // row (direct shares of exactly this category).
  includeSubtree: boolean;
  // null => the rightmost "Итого" column (the whole [from, to] range).
  periodKey: string | null;
}

export interface CellTransaction {
  id: number;
  accountId: number;
  occurredAtUtc: string;
  credit: string;
  debit: string;
  balance: string;
  peer: string | null;
  bankDescription: string | null;
  comment: string | null;
  isCorrecting: boolean;
  // Portion of this transaction attributed to the clicked cell, in minor units.
  shareMinor: number;
}

export function reportCellTransactions(
  request: ReportRequest,
  target: CellTarget,
): Promise<CellTransaction[]> {
  return invoke<CellTransaction[]>("report_cell_transactions", {
    request,
    target,
  });
}

export function seedDemoData(): Promise<void> {
  return invoke<void>("seed_demo_data");
}

export function clearAllData(): Promise<void> {
  return invoke<void>("clear_all_data");
}

// ---------------------------------------------------------------------------
// Documents (bank slips, receipts, …)

/** One upload action from the Documents screen (a batch of files / a ZIP). */
export interface AttachmentUpload {
  id: number;
  uploadedAt: string;
  sourceName: string | null;
  filesTotal: number;
  added: number;
  duplicates: number;
  skipped: number;
}

export type AttachmentExtractStatus =
  | "pending"
  | "done"
  | "partial"
  | "failed"
  | "not_document";

export type AttachmentMatchStatus =
  | "unmatched"
  | "auto"
  | "probable"
  | "manual"
  | "ambiguous"
  /** Unlinked by the user — automatic linking leaves it alone. */
  | "detached";

export interface Attachment {
  id: number;
  uploadId: number;
  uploadedAt: string;
  sha256: string;
  /** Name as uploaded (for ZIP entries — the path inside the archive). */
  originalName: string;
  /** Detected from the file content, not the extension. */
  mimeType: string;
  sizeBytes: number;
  extractStatus: AttachmentExtractStatus | string;
  /** Recognition result as JSON, `null` until recognised. */
  extraction: string | null;
  ocrText: string | null;
  transactionId: number | null;
  matchStatus: AttachmentMatchStatus | string;
}

/** Result of uploading one file (a ZIP counts every entry). */
export interface IngestReport {
  filesTotal: number;
  added: number;
  duplicates: number;
  skipped: number;
  skippedNames: string[];
}

export function beginAttachmentUpload(sourceName: string | null): Promise<number> {
  return invoke<number>("begin_attachment_upload", { sourceName });
}

/** Post one picked file (image, PDF or ZIP) into an open upload. Uses XHR
 *  rather than `fetch` because only XHR reports upload progress — a Google
 *  Drive ZIP can be hundreds of megabytes. */
export function uploadAttachmentFile(
  uploadId: number,
  file: File,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
): Promise<IngestReport> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/attachments/upload/${uploadId}?name=${encodeURIComponent(file.name)}`,
    );
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText) as IngestReport);
      } else {
        reject(xhr.responseText || `HTTP ${xhr.status}`);
      }
    };
    xhr.onerror = () => reject("network error");
    xhr.send(file);
  });
}

/** Tell the server the upload's last file has been sent: once its documents
 *  are recognised (in the background) they are linked to transactions. */
export function finishAttachmentUpload(uploadId: number): Promise<void> {
  return invoke<void>("finish_attachment_upload", { uploadId });
}

/** Background recognition queue; also pushed as the `recognition-status` event. */
export interface RecognitionStatus {
  /** Documents waiting for recognition. */
  pending: number;
  /** Unlinked documents with several fitting transactions. */
  ambiguous: number;
  /** Why the queue is paused (e.g. OCR models missing), if it is. */
  pausedError: string | null;
  /** The user paused the queue (Documents → Pause). */
  pausedByUser: boolean;
  /** The latest automatic linking pass that linked something. */
  lastLink: { linked: number; ambiguous: number } | null;
}

export const RECOGNITION_STATUS_EVENT = "recognition-status";

export function recognitionStatus(): Promise<RecognitionStatus> {
  return invoke<RecognitionStatus>("recognition_status");
}

/** Pause (the document in flight is finished, then the queue stops — linking
 *  too) or resume background recognition. Survives a restart. */
export function setRecognitionPaused(paused: boolean): Promise<RecognitionStatus> {
  return invoke<RecognitionStatus>("set_recognition_paused", { paused });
}

export function listAttachmentUploads(): Promise<AttachmentUpload[]> {
  return invoke<AttachmentUpload[]>("list_attachment_uploads");
}

export function listAttachments(): Promise<Attachment[]> {
  return invoke<Attachment[]>("list_attachments");
}

export function deleteAttachment(id: number): Promise<void> {
  return invoke<void>("delete_attachment", { id });
}

/** Delete several documents together with their links (the slip note shown on
 *  a transaction comes from the document, so it goes too). Returns how many
 *  were deleted. */
export function deleteAttachments(ids: number[]): Promise<number> {
  return invoke<number>("delete_attachments", { ids });
}

export function attachmentFileUrl(id: number): string {
  return `/api/attachments/${id}/file`;
}

/** A document offered for linking, with its distance from the transaction. */
export interface AttachmentCandidate {
  attachment: Attachment;
  /** Document time minus transaction time, seconds. */
  deltaSeconds: number;
}

export interface AttachmentCandidates {
  candidates: AttachmentCandidate[];
  /** Documents with no known time (cannot be placed in a time window). */
  undatedCount: number;
}

/** transaction ↔ document pair, for the Transactions table column. */
export interface AttachmentLink {
  transactionId: number;
  attachmentId: number;
  originalName: string;
  mimeType: string;
  /** The user's note recognised on the document, if any. */
  memo: string | null;
}

export type DocumentAnalysisStatus =
  | "linked"
  | "auto_linked"
  | "ambiguous"
  | "no_match"
  | "no_candidates";

/** Result of the "analyze documents" step for one transaction. */
export interface DocumentAnalysis {
  status: DocumentAnalysisStatus;
  attachmentId: number | null;
  memo: string | null;
  /** Free documents that were in the ±5 min window. */
  candidates: number;
}

/** Recognise the linked document, or find & auto-link one (time + amount +
 *  direction, single candidate). Local OCR; can take a few seconds. */
export function analyzeTransactionDocuments(transactionId: number): Promise<DocumentAnalysis> {
  return invoke<DocumentAnalysis>("analyze_transaction_documents", { transactionId });
}

/** Re-run recognition of one document. */
export function recogniseDocument(attachmentId: number): Promise<void> {
  return invoke<void>("recognise_document", { attachmentId });
}

export function linkAttachment(attachmentId: number, transactionId: number): Promise<void> {
  return invoke<void>("link_attachment", { attachmentId, transactionId });
}

export function unlinkAttachment(attachmentId: number): Promise<void> {
  return invoke<void>("unlink_attachment", { attachmentId });
}

export function listTransactionAttachments(transactionId: number): Promise<Attachment[]> {
  return invoke<Attachment[]>("list_transaction_attachments", { transactionId });
}

export function listAttachmentLinks(): Promise<AttachmentLink[]> {
  return invoke<AttachmentLink[]>("list_attachment_links");
}

export function listAttachmentCandidates(
  transactionId: number,
  windowMinutes: number,
): Promise<AttachmentCandidates> {
  return invoke<AttachmentCandidates>("list_attachment_candidates", {
    transactionId,
    windowMinutes,
  });
}

// ---- Document recognition (Settings → Recognition) ----

/** How documents (slips) are recognised. `local` = PaddleOCR on the server
 *  (default, nothing leaves the machine); `llm` = a vision LLM behind an
 *  OpenAI-compatible endpoint — the document image is sent there. */
export interface RecognitionConfig {
  engine: "local" | "llm";
  presetId?: string;
  baseUrl: string;
  model: string;
  /** Literal key or `env:VAR_NAME`. */
  apiKey: string;
  temperature?: number;
}

export const RECOGNITION_CONFIG_KEY = "document_recognition_config";

export async function loadRecognitionConfig(): Promise<RecognitionConfig> {
  const fallback: RecognitionConfig = { engine: "local", baseUrl: "", model: "", apiKey: "" };
  const raw = await getSetting(RECOGNITION_CONFIG_KEY);
  if (!raw) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<RecognitionConfig>) };
  } catch {
    return fallback;
  }
}

export function saveRecognitionConfig(config: RecognitionConfig): Promise<void> {
  return setSetting(RECOGNITION_CONFIG_KEY, JSON.stringify(config));
}

export function recognitionTestConnection(): Promise<string> {
  return invoke<string>("recognition_test_connection");
}
