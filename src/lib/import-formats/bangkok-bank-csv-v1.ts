import Papa from "papaparse";

import type { ImportFormatPlugin } from "./types";
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

// "27 Apr 2026 11:50" is the canonical shape. Some rows (Interest Credit,
// Withholding Tax — bank-generated AUTO entries) come without a time and
// with a dash-separated, two-digit-year date: "25-Jun-26".
const DATE_RE =
  /^(\d{1,2})[\s-]+([A-Za-z]{3})[\s-]+(\d{4}|\d{2})(?:\s+(\d{1,2}):(\d{2}))?$/;

/** "12,030.00" → "12030.00", "" → "". */
function normalizeAmount(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  return trimmed.replace(/,/g, "");
}

export interface BblDate {
  /** "YYYY-MM-DD" */
  date: string;
  /** "HH:MM", or null when the cell carries only a date. */
  time: string | null;
}

/**
 * "27 Apr 2026 11:50" → { date: "2026-04-27", time: "11:50" };
 * "25-Jun-26" / "25 Jun 2026" → { date: "2026-06-25", time: null };
 * null on parse failure. Two-digit years are 21st century.
 */
export function parseBblDate(raw: string): BblDate | null {
  const m = raw.trim().match(DATE_RE);
  if (!m) return null;
  const [, dd, monStr, yy, hh, mm] = m;
  const mon = MONTHS[monStr.toLowerCase()];
  if (!mon) return null;
  const yyyy = yy.length === 2 ? `20${yy}` : yy;
  const date = `${yyyy}-${mon}-${dd.padStart(2, "0")}`;
  const time = hh === undefined ? null : `${hh.padStart(2, "0")}:${mm}`;
  return { date, time };
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
 * are skipped automatically — they have an empty date cell. A non-empty date
 * cell that doesn't parse is reported as an error rather than dropped: a
 * silently skipped row breaks the balance chain.
 *
 * Date-only rows (no time) take the time of the chronologically previous row
 * when it falls on the same day, and 00:00 otherwise — this keeps them at
 * their bank-given position after the sort.
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
    date: string;
    time: string | null;
    occurredAt: string;
    credit: string;
    debit: string;
    balance: string;
    bankDescription: string;
  }

  const parsed: ParsedRow[] = [];

  for (let i = firstDataIdx; i < data.length; i++) {
    const row = data[i];
    const dateCell = (row[1] ?? "").trim();
    if (dateCell === "") continue;
    const parsedDate = parseBblDate(dateCell);
    if (!parsedDate) {
      errors.push(
        `bangkok-bank: row ${i + 1} has an unrecognized date "${dateCell}"`,
      );
      continue;
    }

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
      ...parsedDate,
      occurredAt: "",
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
  let prev: ParsedRow | null = null;
  for (const r of parsed) {
    const time = r.time ?? (prev?.date === r.date ? prev.time : null) ?? "00:00";
    r.time = time;
    r.occurredAt = `${r.date}T${time}:00`;
    prev = r;
  }
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
  inputKind: "text",
  fileAccept: ".csv,text/csv",
  async parse(input, t) {
    if (input.kind !== "text") {
      return { rows: [], errors: [t("errors.binaryNotSupported")] };
    }
    const { universalCsv, errors: convertErrors } = bankCsvToUniversal(input.text);
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
