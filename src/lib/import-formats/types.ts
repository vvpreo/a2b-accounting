import type { TxnImportRow } from "../api";

export type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export interface CsvParseResult {
  rows: TxnImportRow[];
  errors: string[];
}

export interface ImportFormatPlugin {
  id: string;
  parse(text: string, t: Translate): CsvParseResult;
}
