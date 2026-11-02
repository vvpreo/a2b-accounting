import Papa from "papaparse";

import { extractPdfLines, type PdfLine } from "../pdf-extract";
import { extractPeer } from "./kasikorn-csv-v1";
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
const AMOUNT_RE = /^[\d,]+\.\d{2}$/;

/**
 * X-coordinate boundaries (left edges) for the columns in the Kasikorn
 * K-DEPOSIT PDF statement template. Each entry is `[column, upperBound]`:
 * an item with `x < upperBound` belongs to `column`, otherwise the next
 * boundary is checked. The final column `Details` catches everything past
 * the last bound.
 *
 * Numbers come from inspecting the real PDF (5.7.x rendering): the bank's
 * template is fixed across exports, so empirical thresholds beat
 * header-anchor heuristics — data items in `Channel`/`Details` sit visibly
 * left of their column headings, so closest-anchor classification fails for
 * `Details` text.
 */
const COL_LIMITS: ReadonlyArray<readonly [string, number]> = [
  ["Date", 100],
  ["Time", 120],
  ["Desc", 200],
  ["Amount", 280],
  ["Bal", 330],
  ["Channel", 400],
];

function columnOf(x: number): string {
  for (const [name, max] of COL_LIMITS) if (x < max) return name;
  return "Details";
}

function normalizeAmount(s: string): string {
  return s.replace(/,/g, "");
}

function joinNonEmpty(parts: string[], sep: string): string {
  return parts.filter((p) => p.trim() !== "").join(sep);
}

function parseDate(ddmmyy: string): string | null {
  if (!DATE_RE.test(ddmmyy)) return null;
  const [dd, mm, yy] = ddmmyy.split("-");
  return `20${yy}-${mm}-${dd}`;
}

function parseTime(hhmm: string): string | null {
  if (!TIME_RE.test(hhmm)) return null;
  const [h, m] = hhmm.split(":");
  return `${h.padStart(2, "0")}:${m}`;
}

interface RawRow {
  page: number;
  date: string;
  time: string;
  desc: string[];
  amount: string;
  bal: string;
  channel: string[];
  details: string[];
}

interface ConvertResult {
  universalCsv: string;
  errors: string[];
}

/**
 * Walk extracted PDF lines and emit a universal-CSV string. Pure function over
 * `PdfLine[]` so it can be unit-tested with synthetic input without touching
 * pdfjs.
 *
 * Algorithm per page:
 *   1. Find the table header line (`Descriptions`, `Channel`, `Details` all
 *      present) — everything before it is shipping/account header and
 *      ignored.
 *   2. Iterate subsequent lines. A line whose first item is a `DD-MM-YY`
 *      date in the Date column starts a new transaction; any other line
 *      whose items fall into known data columns is a continuation of the
 *      current transaction (each item appended to the accumulator for its
 *      X-determined column).
 *   3. `Beginning Balance` rows are not emitted — they only carry the
 *      page's opening balance, which validates against the previous page's
 *      last balance (a mismatch becomes a diagnostic error).
 *   4. Sign is inferred from the balance delta: `bal - prev_bal > 0` →
 *      credit, `< 0` → debit. Outstanding Balance values in the PDF are
 *      authoritative; bank's Withdrawal/Deposit sub-columns share one
 *      visual column and don't need to be distinguished by X.
 */
export function linesToUniversalCsv(lines: PdfLine[]): ConvertResult {
  const errors: string[] = [];
  const rawRows: RawRow[] = [];

  // Group lines by page.
  const byPage = new Map<number, PdfLine[]>();
  for (const l of lines) {
    const arr = byPage.get(l.page);
    if (arr) arr.push(l);
    else byPage.set(l.page, [l]);
  }

  for (const [page, pageLines] of [...byPage.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    let headerIdx = -1;
    for (let i = 0; i < pageLines.length; i++) {
      const strs = pageLines[i].items.map((it) => it.str);
      if (
        strs.includes("Descriptions") &&
        strs.includes("Channel") &&
        strs.includes("Details")
      ) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) {
      errors.push(`kasikorn-pdf: page ${page} — transaction table header not found`);
      continue;
    }

    let current: RawRow | null = null;
    for (let i = headerIdx + 1; i < pageLines.length; i++) {
      const ln = pageLines[i];
      if (ln.items.length === 0) continue;
      const first = ln.items[0];
      const isNewRow = DATE_RE.test(first.str) && columnOf(first.x) === "Date";
      if (isNewRow) {
        if (current) rawRows.push(current);
        current = {
          page,
          date: "",
          time: "",
          desc: [],
          amount: "",
          bal: "",
          channel: [],
          details: [],
        };
      } else if (!current) {
        // Stray text before any transaction (e.g. sub-header "Eff.Date / (THB)").
        continue;
      }
      for (const it of ln.items) {
        const col = columnOf(it.x);
        switch (col) {
          case "Date":
            if (DATE_RE.test(it.str)) current!.date = it.str;
            break;
          case "Time":
            if (TIME_RE.test(it.str)) current!.time = it.str;
            break;
          case "Desc":
            current!.desc.push(it.str);
            break;
          case "Amount":
            if (AMOUNT_RE.test(it.str)) current!.amount = normalizeAmount(it.str);
            break;
          case "Bal":
            if (AMOUNT_RE.test(it.str)) current!.bal = normalizeAmount(it.str);
            break;
          case "Channel":
            current!.channel.push(it.str);
            break;
          case "Details":
            current!.details.push(it.str);
            break;
        }
      }
    }
    if (current) rawRows.push(current);
  }

  // Build output, deriving credit/debit from balance delta. Beginning Balance
  // rows seed prev_balance and validate cross-page continuity.
  const universalRows: string[][] = [Array.from(UNIVERSAL_HEADER)];
  let prevBalance: number | null = null;

  for (const r of rawRows) {
    const desc = r.desc.join(" ").trim();
    if (desc === "Beginning Balance") {
      if (!r.bal) {
        errors.push(
          `kasikorn-pdf: page ${r.page} — Beginning Balance row has no balance`,
        );
        continue;
      }
      const bal = Number(r.bal);
      if (prevBalance === null) {
        prevBalance = bal;
      } else if (Math.abs(bal - prevBalance) > 0.005) {
        errors.push(
          `kasikorn-pdf: page ${r.page} — Beginning Balance ${r.bal} doesn't match previous page's last balance ${prevBalance.toFixed(2)}`,
        );
        // Still adopt the bank's number going forward, so a single page-stitch
        // glitch doesn't poison the rest of the statement.
        prevBalance = bal;
      }
      continue;
    }

    if (!r.date) {
      errors.push(`kasikorn-pdf: page ${r.page} — row has no date, skipping`);
      continue;
    }
    if (!r.bal) {
      errors.push(
        `kasikorn-pdf: page ${r.page} — row ${r.date} ${desc || ""} has no balance`,
      );
      continue;
    }
    if (!r.amount) {
      errors.push(
        `kasikorn-pdf: page ${r.page} — row ${r.date} ${desc || ""} has no amount`,
      );
      continue;
    }
    if (prevBalance === null) {
      errors.push(
        `kasikorn-pdf: page ${r.page} — transaction ${r.date} has no preceding Beginning Balance`,
      );
      continue;
    }

    const bal = Number(r.bal);
    const amt = Number(r.amount);
    const delta = bal - prevBalance;
    // Sanity check: |delta| must equal the printed amount, modulo rounding.
    if (Math.abs(Math.abs(delta) - amt) > 0.005) {
      errors.push(
        `kasikorn-pdf: page ${r.page} — row ${r.date} ${desc} balance delta ${delta.toFixed(2)} doesn't match amount ${r.amount}`,
      );
    }
    const credit = delta > 0 ? r.amount : "";
    const debit = delta < 0 ? r.amount : "";

    const isoDate = parseDate(r.date);
    if (!isoDate) {
      errors.push(`kasikorn-pdf: page ${r.page} — invalid date '${r.date}'`);
      continue;
    }
    const time = parseTime(r.time) ?? "00:00";
    const occurredAt = `${isoDate}T${time}:00`;

    const channel = r.channel.join(" ").trim();
    const details = r.details.join(" ").trim();
    const peer = extractPeer(details) ?? "";
    const bankDescription = joinNonEmpty([desc, channel, details], " · ");

    universalRows.push([
      occurredAt,
      credit,
      debit,
      r.bal,
      peer,
      bankDescription,
      "",
    ]);
    prevBalance = bal;
  }

  if (universalRows.length === 1) {
    return { universalCsv: "", errors };
  }

  const universalCsv = Papa.unparse(universalRows, {
    delimiter: ",",
    newline: "\n",
  });
  return { universalCsv, errors };
}

export const kasikornPdfV1: ImportFormatPlugin = {
  id: "kasikorn-pdf-v1",
  inputKind: "binary",
  fileAccept: ".pdf,application/pdf",
  mayBeEncrypted: true,
  async parse(input, t) {
    if (input.kind !== "binary") {
      return { rows: [], errors: [t("errors.textNotSupported")] };
    }
    let lines: PdfLine[];
    try {
      lines = await extractPdfLines(input.data, input.password || undefined);
    } catch (e) {
      const name = e && typeof e === "object" && "name" in e ? e.name : "";
      if (name === "PdfPasswordRequiredError") {
        return { rows: [], errors: [t("errors.pdfPasswordRequired")] };
      }
      if (name === "PdfPasswordIncorrectError") {
        return { rows: [], errors: [t("errors.pdfPasswordIncorrect")] };
      }
      return {
        rows: [],
        errors: [t("errors.pdfReadFailed", { message: String(e) })],
      };
    }

    const { universalCsv, errors: convertErrors } = linesToUniversalCsv(lines);
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
