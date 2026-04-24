import Papa from "papaparse";

import type { TxnImportRow } from "./api";

export interface CsvParseResult {
  rows: TxnImportRow[];
  errors: string[];
}

export function parseTransactionsCsv(text: string): CsvParseResult {
  const { data, errors: parseErrors } = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  const errors: string[] = parseErrors.map(
    (e) => `CSV parse error at row ${e.row ?? "?"}: ${e.message}`,
  );
  const rows: TxnImportRow[] = [];

  data.forEach((r, i) => {
    const occurredAt = (r.occurred_at ?? r.occurredAt ?? "").trim();
    const peer = (r.peer ?? "").trim();
    const credit = (r.credit ?? "").trim();
    const debit = (r.debit ?? "").trim();
    const balance = (r.balance ?? "").trim();
    const description = (r.description ?? "").trim();

    const rowNum = i + 2; // +1 for 0-index, +1 for header line
    if (!occurredAt) {
      errors.push(`Row ${rowNum}: missing occurred_at`);
      return;
    }
    if (!balance) {
      errors.push(`Row ${rowNum}: missing balance`);
      return;
    }
    rows.push({ occurredAt, peer, credit, debit, balance, description });
  });

  return { rows, errors };
}
