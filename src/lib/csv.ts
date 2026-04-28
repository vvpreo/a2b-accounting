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

function pickString(r: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

function pickOptional(
  r: Record<string, string>,
  ...keys: string[]
): string | null {
  const v = pickString(r, ...keys);
  return v === "" ? null : v;
}

/**
 * Supported delimiters: tab, comma, semicolon. Whitespace-aligned dumps are
 * not supported — the user must convert them to one of the three first.
 */
function detectDelimiter(text: string): string | null {
  const firstLine = text.split("\n").find((l) => l.trim() !== "") ?? "";
  if (firstLine.includes("\t")) return "\t";
  if (firstLine.includes(";")) return ";";
  if (firstLine.includes(",")) return ",";
  return null;
}

export function parseTransactionsCsv(
  text: string,
  t: Translate,
): CsvParseResult {
  const delimiter = detectDelimiter(text);
  if (delimiter === null) {
    return {
      rows: [],
      errors: [t("errors.unknownDelimiter")],
    };
  }

  const { data, errors: parseErrors } = Papa.parse<Record<string, string>>(
    text,
    {
      header: true,
      skipEmptyLines: true,
      delimiter,
      transformHeader: (h) => h.trim(),
    },
  );

  // FieldMismatch fires when trailing optional columns are missing — we
  // handle that gracefully via pickOptional. Keep only true parser errors.
  const errors: string[] = parseErrors
    .filter((e) => e.type !== "FieldMismatch")
    .map((e) =>
      t("errors.csvParse", {
        row: e.row ?? "?",
        message: e.message,
      }),
    );
  const rows: TxnImportRow[] = [];

  data.forEach((r, i) => {
    const occurredAt = pickString(r, "occurred_at", "occurredAt");
    const credit = pickString(r, "credit");
    const debit = pickString(r, "debit");
    const balance = pickString(r, "balance");
    const peer = pickOptional(r, "peer");
    const bankDescription = pickOptional(r, "bank_description", "bankDescription");
    const comment = pickOptional(r, "comment");

    const rowNum = i + 2;
    if (!occurredAt) {
      errors.push(t("errors.missingOccurredAt", { row: rowNum }));
      return;
    }
    if (!balance) {
      errors.push(t("errors.missingBalance", { row: rowNum }));
      return;
    }
    rows.push({
      occurredAt,
      credit,
      debit,
      balance,
      peer,
      bankDescription,
      comment,
    });
  });

  return { rows, errors };
}
