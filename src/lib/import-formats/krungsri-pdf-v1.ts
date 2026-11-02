import Papa from "papaparse";

import { extractPdfLines, type PdfLine, type PdfTextItem } from "../pdf-extract";
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

/** The date, the time and the (truncated) transaction type share one PDF text
 *  item: `05/03/2026 10:15:20 Transfer Deposit`. */
const ROW_RE = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2}:\d{2})\s*(.*)$/;
const AMOUNT_RE = /^[\d,]+\.\d{2}$/;
const TOTAL_RE = /^Total (Withdrawal|Deposit)$/;
const TOTAL_COUNT_RE = /^(\d+) items?$/;

/**
 * Column geometry of the Krungsri "Statement of Savings Account" PDF template,
 * from inspecting a real statement. Left edges work for the text columns.
 * Amounts are right-aligned, so a long number grows to the left and only its
 * right edge (`x + width`) identifies the column.
 */
const AMOUNTS_MIN_X = 200;
const CHANNEL_MIN_X = 420;
const DESCRIPTION_MIN_X = 468;
const WITHDRAWAL_MAX_RIGHT = 305;
const DEPOSIT_MAX_RIGHT = 360;

function toMinor(amount: string): number {
  return Math.round(Number(amount.replace(/,/g, "")) * 100);
}

function formatMinor(minor: number): string {
  return (minor / 100).toFixed(2);
}

function joinNonEmpty(parts: string[], sep: string): string {
  return parts.filter((p) => p.trim() !== "").join(sep);
}

/**
 * Peer from the Description lines. A transfer or QR payment carries a name
 * (cut by the bank with `...`), an account number, or both:
 *   `KBANK MR. JOHN DO...` + `From Acc No. : X123456` → `KBANK MR. JOHN DO X123456`.
 * The account matters: QR payments often name only the acquirer, and the
 * number is what tells two merchants apart. Lines that only describe the
 * channel (the account owner's own card, an e-wallet top-up) name no peer.
 */
export function extractPeer(description: string[]): string {
  const parts: string[] = [];
  for (const line of description) {
    const account = line.match(/^(?:From|To) Acc No\.\s*:\s*(\S+)$/i);
    if (account) {
      parts.push(account[1]);
    } else if (!/^(?:From Card No\.|Transfer to E-wallet$)/i.test(line)) {
      parts.push(line.replace(/\.{3}$/, "").trim());
    }
  }
  return joinNonEmpty(parts, " ");
}

interface RawRow {
  page: number;
  date: string;
  time: string;
  transaction: string;
  withdrawal: string;
  deposit: string;
  balance: string;
  channel: string[];
  description: string[];
}

interface Total {
  count: number;
  amount: number;
}

interface ConvertResult {
  universalCsv: string;
  errors: string[];
}

function parseTotal(items: PdfTextItem[]): Total | null {
  let count: number | null = null;
  let amount: number | null = null;
  for (const it of items) {
    const m = it.str.match(TOTAL_COUNT_RE);
    if (m) count = Number(m[1]);
    else if (AMOUNT_RE.test(it.str)) amount = toMinor(it.str);
  }
  return count === null || amount === null ? null : { count, amount };
}

/**
 * Walk extracted PDF lines and emit a universal-CSV string. Pure function over
 * `PdfLine[]` so it can be unit-tested with synthetic input without touching
 * pdfjs.
 *
 * Unlike Kasikorn, the statement prints no opening balance, so the direction
 * can't be derived from the balance delta for the first row. Withdrawal and
 * Deposit are visually separate columns here, so the direction comes from the
 * column; it can't come from the transaction type either, because a card refund
 * is a `Spending` row in the Deposit column. The balance chain and the `Total
 * Withdrawal` / `Total Deposit` summary then verify the result.
 */
export function linesToUniversalCsv(lines: PdfLine[]): ConvertResult {
  const errors: string[] = [];
  const rawRows: RawRow[] = [];
  const totals: Record<string, Total | null> = {};

  const byPage = new Map<number, PdfLine[]>();
  for (const l of lines) {
    const arr = byPage.get(l.page);
    if (arr) arr.push(l);
    else byPage.set(l.page, [l]);
  }

  // Kept across pages: a row's Description can continue on the next page.
  let current: RawRow | null = null;

  for (const [page, pageLines] of [...byPage.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const headerIdx = pageLines.findIndex((l) => {
      const strs = l.items.map((it) => it.str);
      return (
        strs.includes("Date/Time") &&
        strs.includes("Channel") &&
        strs.includes("Description")
      );
    });
    if (headerIdx === -1) {
      errors.push(`krungsri-pdf: page ${page} — transaction table header not found`);
      continue;
    }

    for (const ln of pageLines.slice(headerIdx + 1)) {
      const totalMatch = ln.items[0]?.str.match(TOTAL_RE);
      if (totalMatch) {
        totals[totalMatch[1]] = parseTotal(ln.items);
        current = null;
        continue;
      }

      const left = ln.items
        .filter((it) => it.x < AMOUNTS_MIN_X)
        .map((it) => it.str)
        .join(" ");
      const rowMatch = left.match(ROW_RE);
      if (rowMatch) {
        const [, dd, mm, yyyy, time, transaction] = rowMatch;
        current = {
          page,
          date: `${yyyy}-${mm}-${dd}`,
          time,
          transaction: transaction.trim(),
          withdrawal: "",
          deposit: "",
          balance: "",
          channel: [],
          description: [],
        };
        rawRows.push(current);
      }
      if (!current) continue;

      // Only the text columns wrap; the page footer sits left of them, so it
      // never reaches the last row's Description.
      for (const it of ln.items) {
        if (it.x >= DESCRIPTION_MIN_X) {
          current.description.push(it.str);
        } else if (it.x >= CHANNEL_MIN_X) {
          current.channel.push(it.str);
        } else if (rowMatch && it.x >= AMOUNTS_MIN_X && AMOUNT_RE.test(it.str)) {
          const right = it.x + it.width;
          if (right < WITHDRAWAL_MAX_RIGHT) current.withdrawal = it.str;
          else if (right < DEPOSIT_MAX_RIGHT) current.deposit = it.str;
          else current.balance = it.str;
        }
      }
    }
  }

  const universalRows: string[][] = [Array.from(UNIVERSAL_HEADER)];
  const sums = {
    Withdrawal: { count: 0, amount: 0 },
    Deposit: { count: 0, amount: 0 },
  };
  let prevBalance: number | null = null;
  let prevOccurredAt = "";

  for (const r of rawRows) {
    const label = `page ${r.page} — row ${r.date} ${r.time} ${r.transaction}`;
    if (!r.balance) {
      errors.push(`krungsri-pdf: ${label} has no balance`);
      continue;
    }
    if (!r.withdrawal === !r.deposit) {
      errors.push(`krungsri-pdf: ${label} must have exactly one of withdrawal/deposit`);
      continue;
    }

    const amount = toMinor(r.withdrawal || r.deposit);
    const balance = toMinor(r.balance);
    const sum = r.deposit ? sums.Deposit : sums.Withdrawal;
    sum.count += 1;
    sum.amount += amount;

    if (prevBalance !== null) {
      const delta = balance - prevBalance;
      if (delta !== (r.deposit ? amount : -amount)) {
        errors.push(
          `krungsri-pdf: ${label} balance delta ${formatMinor(delta)} doesn't match amount ${r.withdrawal || r.deposit}`,
        );
      }
    }
    prevBalance = balance;

    // Interest and tax rows are stamped 00:00:00 but may be listed after other
    // rows of the same day. Rows are ordered by timestamp, so such a row takes
    // the previous one's time to keep its place in the balance chain.
    let occurredAt = `${r.date}T${r.time}`;
    if (occurredAt < prevOccurredAt && prevOccurredAt.startsWith(r.date)) {
      occurredAt = prevOccurredAt;
    }
    prevOccurredAt = occurredAt;

    const channel = r.channel.join(" ").trim();
    const description = r.description.join(" ").trim();
    universalRows.push([
      occurredAt,
      r.deposit ? formatMinor(amount) : "",
      r.withdrawal ? formatMinor(amount) : "",
      formatMinor(balance),
      extractPeer(r.description),
      joinNonEmpty([r.transaction, channel, description], " · "),
      "",
    ]);
  }

  if (universalRows.length === 1) {
    return { universalCsv: "", errors };
  }

  for (const kind of ["Withdrawal", "Deposit"] as const) {
    const total = totals[kind];
    const sum = sums[kind];
    if (!total) {
      errors.push(`krungsri-pdf: Total ${kind} summary not found — the statement may be incomplete`);
    } else if (total.count !== sum.count || total.amount !== sum.amount) {
      errors.push(
        `krungsri-pdf: Total ${kind} says ${total.count} items / ${formatMinor(total.amount)}, parsed ${sum.count} items / ${formatMinor(sum.amount)}`,
      );
    }
  }

  const universalCsv = Papa.unparse(universalRows, {
    delimiter: ",",
    newline: "\n",
  });
  return { universalCsv, errors };
}

export const krungsriPdfV1: ImportFormatPlugin = {
  id: "krungsri-pdf-v1",
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
