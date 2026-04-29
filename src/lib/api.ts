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
