import Papa from "papaparse";

import type { TxnImportRow } from "./api";

export interface CsvParseResult {
  rows: TxnImportRow[];
  errors: string[];
}

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export function parseTransactionsCsv(
  text: string,
  t: Translate,
): CsvParseResult {
  const { data, errors: parseErrors } = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  const errors: string[] = parseErrors.map((e) =>
    t("errors.csvParse", {
      row: e.row ?? "?",
      message: e.message,
    }),
  );
  const rows: TxnImportRow[] = [];

  data.forEach((r, i) => {
    const occurredAt = (r.occurred_at ?? r.occurredAt ?? "").trim();
    const peer = (r.peer ?? "").trim();
    const credit = (r.credit ?? "").trim();
    const debit = (r.debit ?? "").trim();
    const balance = (r.balance ?? "").trim();
    const description = (r.description ?? "").trim();

    const rowNum = i + 2;
    if (!occurredAt) {
      errors.push(t("errors.missingOccurredAt", { row: rowNum }));
      return;
    }
    if (!balance) {
      errors.push(t("errors.missingBalance", { row: rowNum }));
      return;
    }
    rows.push({ occurredAt, peer, credit, debit, balance, description });
  });

  return { rows, errors };
}
