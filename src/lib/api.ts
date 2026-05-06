import { invoke } from "@tauri-apps/api/core";

export interface Account {
  id: number;
  name: string;
  bank: string;
  currency: string;
  accountNumber: string;
  ownerName: string;
  createdAt: string;
}

export interface Transaction {
  id: number;
  accountId: number;
  importBatchId: number;
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

export function createAccount(args: {
  name: string;
  bank: string;
  currency: string;
  accountNumber: string;
  ownerName: string;
}): Promise<Account> {
  return invoke<Account>("create_account", args);
}

export function listAccounts(): Promise<Account[]> {
  return invoke<Account[]>("list_accounts");
}

export function updateAccount(args: {
  id: number;
  name: string;
  bank: string;
  currency: string;
  accountNumber: string;
  ownerName: string;
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

export function updateTransactionComment(
  id: number,
  comment: string | null,
): Promise<void> {
  return invoke<void>("update_transaction_comment", { id, comment });
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

export function seedDemoData(): Promise<void> {
  return invoke<void>("seed_demo_data");
}

export function clearAllData(): Promise<void> {
  return invoke<void>("clear_all_data");
}
