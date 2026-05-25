import type { TxnImportRow } from "../api";

export type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export interface CsvParseResult {
  rows: TxnImportRow[];
  errors: string[];
}

export type ParseInput =
  | { kind: "text"; text: string }
  | { kind: "binary"; data: ArrayBuffer; password?: string };

export interface ImportFormatPlugin {
  id: string;
  /** Whether the format consumes raw text (CSV/TSV) or binary (PDF, XLSX...). */
  inputKind: "text" | "binary";
  /** `accept` attribute for the <input type="file"> picker. */
  fileAccept: string;
  /** Set true for binary formats that may require a password (e.g. encrypted
   *  PDFs). The import wizard shows a password field when true. */
  mayBeEncrypted?: boolean;
  parse(input: ParseInput, t: Translate): Promise<CsvParseResult>;
}
