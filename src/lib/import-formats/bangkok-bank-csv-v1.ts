import Papa from "papaparse";

import type { CsvParseResult, ImportFormatPlugin, Translate } from "./types";
import { parseUniversalCsv } from "./universal-csv";

const UNIVERSAL_HEADER = [
  "occurred_at",
  "credit",
  "debit",
  "balance",
  "peer",
  "bank_description",
  "comment",
] as const;

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

const DATE_RE = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})$/;

/** "12,030.00" → "12030.00", "" → "". */
function normalizeAmount(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  return trimmed.replace(/,/g, "");
}

/** "27 Apr 2026 11:50" → "2026-04-27T11:50:00", or null on parse failure. */
export function parseBblDate(raw: string): string | null {
  const m = raw.trim().match(DATE_RE);
  if (!m) return null;
  const [, dd, monStr, yyyy, hh, mm] = m;
  const mon = MONTHS[monStr.toLowerCase()];
  if (!mon) return null;
  const d = dd.padStart(2, "0");
  const h = hh.padStart(2, "0");
  return `${yyyy}-${mon}-${d}T${h}:${mm}:00`;
}

function joinNonEmpty(parts: string[], sep: string): string {
  return parts.filter((p) => p.trim() !== "").join(sep);
}

interface ConvertResult {
  universalCsv: string;
  errors: string[];
}

/**
 * Convert a Bangkok Bank statement CSV ("MyDownLoad…csv" from BBL iBanking /
 * Bualuang mBanking) to the universal CSV format.
 *
 * The bank exports rows newest-first; we reverse and stable-sort by
 * `occurred_at` so the chain of balances reads correctly through the
 * universal-CSV pipeline. Account / card-number / Total / Disclaimer rows
 * are skipped automatically — the parser only consumes rows whose date cell
 * matches the canonical "DD MMM YYYY HH:MM" shape.
 */
export function bankCsvToUniversal(text: string): ConvertResult {
  const errors: string[] = [];
  const { data, errors: parseErrors } = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: true,
  });

  for (const e of parseErrors) {
    if (e.type !== "FieldMismatch") {
      errors.push(
        `bangkok-bank: CSV parse error at row ${e.row ?? "?"}: ${e.message}`,
      );
    }
  }

  let firstDataIdx = -1;
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (
      row.length > 5 &&
      (row[1] ?? "").trim() === "Date" &&
      (row[2] ?? "").trim() === "Description" &&
      (row[3] ?? "").trim() === "Debit"
    ) {
      firstDataIdx = i + 1;
      break;
    }
  }

  if (firstDataIdx === -1) {
    errors.push("bangkok-bank: transaction table header not found");
    return { universalCsv: "", errors };
  }

  interface ParsedRow {
    occurredAt: string;
    credit: string;
    debit: string;
    balance: string;
    bankDescription: string;
  }

  const parsed: ParsedRow[] = [];

  for (let i = firstDataIdx; i < data.length; i++) {
    const row = data[i];
    const occurredAt = parseBblDate(row[1] ?? "");
    if (!occurredAt) continue;

    const description = (row[2] ?? "").trim();
    if (description === "" || description.toLowerCase() === "total") continue;

    const debit = normalizeAmount(row[3] ?? "");
    const credit = normalizeAmount(row[4] ?? "");
    const balance = normalizeAmount(row[5] ?? "");
    const channel = (row[6] ?? "").trim();

    if (balance === "") {
      errors.push(`bangkok-bank: row ${i + 1} has no balance, skipping`);
      continue;
    }

    parsed.push({
      occurredAt,
      credit,
      debit,
      balance,
      bankDescription: joinNonEmpty([description, channel], " · "),
    });
  }

  // BBL exports newest-first; reverse so equal-timestamp groups end up in
  // chronological order, then stable-sort to handle out-of-order rows. JS
  // Array.prototype.sort is stable since ES2019, so the reverse-then-sort
  // approach preserves the corrected intra-minute ordering.
  parsed.reverse();
  parsed.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  const universalRows: string[][] = [Array.from(UNIVERSAL_HEADER)];
  for (const r of parsed) {
    universalRows.push([
      r.occurredAt,
      r.credit,
      r.debit,
      r.balance,
      "",
      r.bankDescription,
      "",
    ]);
  }

  const universalCsv = Papa.unparse(universalRows, {
    delimiter: ",",
    newline: "\n",
  });

  return { universalCsv, errors };
}

export const bangkokBankCsvV1: ImportFormatPlugin = {
  id: "bangkok-bank-csv-v1",
  parse(text: string, t: Translate): CsvParseResult {
    const { universalCsv, errors: convertErrors } = bankCsvToUniversal(text);
    if (universalCsv === "") {
      return { rows: [], errors: convertErrors };
    }
    const inner = parseUniversalCsv(universalCsv, t);
    return {
      rows: inner.rows,
      errors: [...convertErrors, ...inner.errors],
    };
  },
};
