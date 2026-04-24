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
  occurredAtTz: string;
  peer: string;
  credit: string;
  debit: string;
  balance: string;
  description: string;
}

export interface ImportBatch {
  id: number;
  accountId: number;
  importedAt: string;
  sourceFilename: string | null;
  rowCount: number;
}

export interface ValidationError {
  txnId: number;
  expectedBalance: string;
  actualBalance: string;
  occurredAtUtc: string;
  description: string;
}

export interface ImportResult {
  batchId: number;
  inserted: number;
  validationErrors: ValidationError[];
}

export interface TxnImportRow {
  occurredAt: string;
  peer: string;
  credit: string;
  debit: string;
  balance: string;
  description: string;
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

export function importTransactions(args: {
  accountId: number;
  sourceFilename: string | null;
  rows: TxnImportRow[];
}): Promise<ImportResult> {
  return invoke<ImportResult>("import_transactions", args);
}

export function listTransactions(accountId: number): Promise<Transaction[]> {
  return invoke<Transaction[]>("list_transactions", { accountId });
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
