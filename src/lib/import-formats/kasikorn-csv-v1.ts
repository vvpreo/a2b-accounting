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

const DATE_RE = /^\d{2}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;

/** Strip Kasikorn's thousand separators ("90,000.00" → "90000.00"). Empty
 *  cells stay empty so the universal-CSV layer can tell credit from debit. */
function normalizeAmount(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  return trimmed.replace(/,/g, "");
}

/** "04-05-25" → "2025-05-04" (Kasikorn statements use 2-digit years; we
 *  assume the 21st century — the bank only keeps 10 years of history). */
function parseDate(ddmmyy: string): string | null {
  if (!DATE_RE.test(ddmmyy)) return null;
  const [dd, mm, yy] = ddmmyy.split("-");
  return `20${yy}-${mm}-${dd}`;
}

/** Returns "HH:MM" zero-padded, or null when the cell isn't a time. */
function parseTime(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!TIME_RE.test(trimmed)) return null;
  const [h, m] = trimmed.split(":");
  return `${h.padStart(2, "0")}:${m}`;
}

/**
 * Pull a counterparty out of Kasikorn's free-form "Details" column.
 * Common shapes:
 *   - "From BBL X5734 MR VLADIMIR PREOBR++"   → "BBL X5734 MR VLADIMIR PREOBR++"
 *   - "To X3302 MRS. ANASTASIIA PR++"          → "X3302 MRS. ANASTASIIA PR++"
 *   - "To PromptPay X6096 DANILA KARPYZ++"     → "PromptPay X6096 DANILA KARPYZ++"
 *   - "Paid for Ref X8826 T2P"                  → "T2P"
 *   - "Paid for Ref X1777 INDEX LIVING ..."    → "INDEX LIVING ..."
 *   - "Ref Code ATM47002"                       → null  (system reference, no peer)
 *   - "Ref Code PCB09400"                       → null
 * Anything that doesn't match a known shape returns null — better to leave
 * `peer` empty than to guess wrong; the full text is still preserved in
 * `bank_description`.
 */
export function extractPeer(details: string): string | null {
  const d = details.trim();
  if (d === "") return null;
  if (/^Ref\s+Code\b/i.test(d)) return null;
  const fromTo = d.match(/^(?:From|To)\s+(.+)$/i);
  if (fromTo) return fromTo[1].trim();
  const paidFor = d.match(/^Paid for Ref\s+\S+\s+(.+)$/i);
  if (paidFor) return paidFor[1].trim();
  return null;
}

function joinNonEmpty(parts: string[], sep: string): string {
  return parts.filter((p) => p.trim() !== "").join(sep);
}

interface ConvertResult {
  universalCsv: string;
  /** Row indices (1-based, in source file) of skipped rows for diagnostics. */
  errors: string[];
}

/**
 * Convert a Kasikorn K-DEPOSIT CSV statement to the project's universal-CSV
 * format. Pure string-in/string-out so it's trivially testable: feed in a
 * fixture, compare the output to the expected universal CSV.
 *
 * Header rows (account info, period, totals) are skipped automatically — we
 * scan for the canonical "Date / Descriptions / Withdrawal / Deposit /
 * Outstanding Balance / Channel / Details" header and start reading data on
 * the next line. The "Beginning Balance" row is dropped: it carries no credit
 * or debit, only an opening balance the universal pipeline doesn't model.
 */
export function bankCsvToUniversal(text: string): ConvertResult {
  const errors: string[] = [];
  const { data, errors: parseErrors } = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: true,
  });

  for (const e of parseErrors) {
    if (e.type !== "FieldMismatch") {
      errors.push(`kasikorn: CSV parse error at row ${e.row ?? "?"}: ${e.message}`);
    }
  }

  let firstDataIdx = -1;
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (
      row.length > 3 &&
      (row[1] ?? "").trim() === "Date" &&
      (row[3] ?? "").trim() === "Descriptions"
    ) {
      firstDataIdx = i + 1;
      break;
    }
  }

  if (firstDataIdx === -1) {
    errors.push("kasikorn: transaction table header not found");
    return { universalCsv: "", errors };
  }

  const universalRows: string[][] = [Array.from(UNIVERSAL_HEADER)];

  for (let i = firstDataIdx; i < data.length; i++) {
    const row = data[i];
    const isoDate = parseDate((row[1] ?? "").trim());
    if (!isoDate) continue;

    const description = (row[3] ?? "").trim();
    if (description === "Beginning Balance") continue;

    const time = parseTime(row[2] ?? "") ?? "00:00";
    const debit = normalizeAmount(row[4] ?? "");
    const credit = normalizeAmount(row[6] ?? "");
    const balance = normalizeAmount(row[8] ?? "");
    const channel = (row[10] ?? "").trim();
    const details = (row[12] ?? "").trim();

    if (balance === "") {
      errors.push(`kasikorn: row ${i + 1} has no balance, skipping`);
      continue;
    }

    const occurredAt = `${isoDate}T${time}:00`;
    const peer = extractPeer(details) ?? "";
    const bankDescription = joinNonEmpty(
      [description, channel, details],
      " · ",
    );

    universalRows.push([
      occurredAt,
      credit,
      debit,
      balance,
      peer,
      bankDescription,
      "",
    ]);
  }

  const universalCsv = Papa.unparse(universalRows, {
    delimiter: ",",
    newline: "\n",
  });

  return { universalCsv, errors };
}

export const kasikornCsvV1: ImportFormatPlugin = {
  id: "kasikorn-csv-v1",
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
