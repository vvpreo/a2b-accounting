import { CashDirection, TelegramPending, Transaction } from "./api";
import { parseMoneyToMinor } from "./money";

/**
 * A Telegram channel export (HTML) as cash entries, by plain rules:
 * - a message with an attachment or without text is not counted;
 * - each line stands on its own, so one message can give several entries;
 * - a number at the start of a line is the amount: an expense, with a plus an
 *   income; otherwise a single number in the line reads the same way;
 * - several numbers in a line, or an amount not written plainly, go to "review";
 * - no number in the whole message: "ignore".
 * A message ignored earlier comes back on "ignore" and can be moved from there.
 * The owner checks the first file by eye and sticks to `[+]amount[ ]comment`
 * after that. See docs/plans/telegram-cash-import.md.
 */

export interface ExportMessage {
  id: number;
  /** As printed in the file: `YYYY-MM-DD`, `HH:MM:SS`, no time zone. */
  date: string;
  time: string;
  text: string;
}

export interface ParsedExport {
  title: string | null;
  /** Messages with text, oldest first. */
  messages: ExportMessage[];
  /** Messages with an attachment of any kind, or without text — never entries. */
  ignored: number;
  /** Date strings that could not be read, on messages with text. */
  badDates: string[];
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] !== "#") return ENTITIES[body.toLowerCase()] ?? whole;
    const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isNaN(code) ? whole : String.fromCodePoint(code);
  });
}

function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
}

/** `16 November 2024, 12:34:56` → date and time. */
function parseExportDate(title: string): { date: string; time: string } | null {
  const m = /^(\d{1,2}) ([A-Za-z]+) (\d{4}), (\d{2}:\d{2}:\d{2})$/.exec(title.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  return {
    date: `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`,
    time: m[4],
  };
}

/** Several files of one export are passed as several strings. */
export function parseTelegramExport(files: string[]): ParsedExport {
  const byId = new Map<number, ExportMessage>();
  let title: string | null = null;
  let ignored = 0;
  const badDates: string[] = [];
  for (const html of files) {
    const fileTitle = /<title>([\s\S]*?)<\/title>/i.exec(html);
    title ??= fileTitle ? decodeEntities(fileTitle[1]).trim() || null : null;
    for (const block of html.split(/(?=<div class="message )/).slice(1)) {
      if (/^<div class="message service/.test(block)) continue;
      const id = /\bid="message(\d+)"/.exec(block);
      if (!id) continue;
      const text = /<div class="text(?: [^"]*)?">([\s\S]*?)<\/div>/.exec(block);
      const body = text ? htmlToText(text[1]) : "";
      if (!body || /class="media_wrap\b/.test(block)) {
        ignored += 1;
        continue;
      }
      const printed = /class="[^"]*\bdate\b[^"]*"\s+title="([^"]*)"/.exec(block)?.[1] ?? "";
      const when = parseExportDate(printed);
      if (!when) {
        badDates.push(printed);
        continue;
      }
      byId.set(Number(id[1]), { id: Number(id[1]), ...when, text: body });
    }
  }
  return {
    title,
    messages: [...byId.values()].sort((a, b) => a.id - b.id),
    ignored,
    badDates,
  };
}

export type Bucket = "out" | "in" | "review" | "ignore";

export type Reason = "looseAmount" | "severalNumbers" | "possibleDuplicate" | "ignoredEarlier";

export interface Classified {
  bucket: Bucket;
  /** Empty when there is nothing to take as the amount. */
  amount: string;
  comment: string;
  reasons: Reason[];
}

/** Words for a currency written next to the amount: not part of the comment. */
const CURRENCY_WORDS: Record<string, string> = {
  THB: "бат[а-яё]*|thb|baht|bat|б|b|฿",
  USD: "доллар[а-яё]*|бакс[а-яё]*|usd|\\$",
  EUR: "евро|eur|€",
  RUB: "рубл[а-яё]*|руб|rub|₽",
  KZT: "тенге|kzt|₸",
  CNY: "юан[а-яё]*|cny",
  VND: "донг[а-яё]*|vnd",
  MYR: "ринггит[а-яё]*|myr",
};

const L = "\\p{L}";
const CASH_WORD = new RegExp(`(?<![${L}])#?(?:к[эе]ш[а-яё]*|cash)(?![${L}])`, "giu");

interface ReadAmount {
  amount: string;
  length: number;
  loose: boolean;
}

/** Read the number at the start of `s`. Only `123` and `123.45` are the
 *  notation; `1.000`, `10 000` and `8к` are read too, but marked as loose. */
function readAmount(s: string): ReadAmount | null {
  let m = /^(\d{1,3}(?:[  ]\d{3})+)(?:[.,](\d{1,2}))?(?!\d)/.exec(s);
  let loose = true;
  if (!m) m = /^(\d{1,3}(?:[.,]\d{3})+)(?:[.,](\d{1,2}))?(?!\d)/.exec(s);
  if (!m) {
    m = /^(\d+)(?:[.,](\d{1,2}))?(?!\d)/.exec(s);
    loose = false;
  }
  if (!m) return null;
  const whole = m[1].replace(/\D/g, "");
  const thousands = new RegExp(`^\\s*(?:к|k|тыс\\.?)(?![${L}\\d])`, "iu").exec(s.slice(m[0].length));
  if (thousands) {
    return { amount: String(Number(whole) * 1000), length: m[0].length + thousands[0].length, loose: true };
  }
  return { amount: m[2] ? `${whole}.${m[2]}` : whole, length: m[0].length, loose };
}

/** Is this the account's currency, right after an amount? */
function currencyAt(after: string, currency: string): boolean {
  const own = CURRENCY_WORDS[currency];
  return Boolean(own) && new RegExp(`^(?:${own})(?![${L}])`, "iu").test(after);
}

/** The numbers standing on their own, not parts of words like `x9` or `3й`. */
function standaloneNumbers(s: string, currency: string): { read: ReadAmount; index: number }[] {
  const found: { read: ReadAmount; index: number }[] = [];
  const re = new RegExp(`(?<![${L}\\d.,/:])\\d`, "gu");
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const read = readAmount(s.slice(m.index));
    if (!read) continue;
    const after = s.slice(m.index + read.length);
    if (!new RegExp(`^[${L}]`, "u").test(after) || currencyAt(after, currency)) found.push({ read, index: m.index });
    re.lastIndex = m.index + read.length;
  }
  return found;
}

/** The account's currency right after the amount says nothing. */
function dropCurrency(after: string, currency: string): string {
  const own = CURRENCY_WORDS[currency];
  return own ? after.replace(new RegExp(`^\\s*(?:${own})(?![${L}])\\.?`, "iu"), "") : after;
}

function cleanComment(raw: string): string {
  const s = raw.replace(CASH_WORD, " ").replace(/\s+/g, " ").trim();
  return s.replace(/^[\s:;,.–—-]+/, "").replace(/[\s:;,–—-]+$/, "");
}

/** Sort one line by the rules at the top of this file. */
export function classifyLine(text: string, currency: string): Classified {
  const trimmed = text.trim();
  const plus = /^\+\s*/.exec(trimmed);
  const body = plus ? trimmed.slice(plus[0].length) : trimmed;

  if (/^\d/.test(body)) {
    const read = readAmount(body)!;
    const after = body.slice(read.length);
    const plain = /^(?:\s|$)/.test(after) || currencyAt(after, currency);
    const comment = cleanComment(dropCurrency(after, currency));
    if (!read.loose && !plain) {
      // Not an amount at all: "7ка", "3й", "03/04".
      return { bucket: "review", amount: "", comment: cleanComment(body), reasons: ["looseAmount"] };
    }
    const reasons: Reason[] = read.loose ? ["looseAmount"] : [];
    return { bucket: reasons.length > 0 ? "review" : plus ? "in" : "out", amount: read.amount, comment, reasons };
  }

  const numbers = standaloneNumbers(trimmed, currency);
  if (numbers.length === 0) return { bucket: "ignore", amount: "", comment: cleanComment(trimmed), reasons: [] };
  const { read, index } = numbers[0];
  if (numbers.length > 1) {
    return { bucket: "review", amount: read.amount, comment: cleanComment(trimmed), reasons: ["severalNumbers"] };
  }
  const before = trimmed.slice(0, index);
  const plusBefore = /\+\s*$/.test(before);
  const comment = cleanComment(
    `${before.replace(/\+\s*$/, "")} ${dropCurrency(trimmed.slice(index + read.length), currency)}`,
  );
  if (read.loose) return { bucket: "review", amount: read.amount, comment, reasons: ["looseAmount"] };
  return { bucket: plusBefore ? "in" : "out", amount: read.amount, comment, reasons: [] };
}

/** Sort a whole message: one entry per line with a number. Lines without a number
 *  say nothing on their own; next to a single entry they stay in its comment. */
export function classifyMessage(text: string, currency: string): Classified[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const sorted = lines.map((line) => ({ line, c: classifyLine(line, currency) }));
  const entries = sorted.filter((x) => x.c.bucket !== "ignore");
  if (entries.length === 0) return [classifyLine(lines.join(" "), currency)];
  if (entries.length > 1) return entries.map((x) => x.c);
  const comment = cleanComment(sorted.map((x) => (x.c.bucket === "ignore" ? x.line : x.c.comment)).join(" "));
  return [{ ...entries[0].c, comment }];
}

export interface WizardRow {
  key: number;
  messageId: number;
  text: string;
  date: string;
  time: string;
  bucket: Bucket;
  amount: string;
  comment: string;
  categoryId: number | null;
  reasons: Reason[];
  /** The entry already on the account that this row may repeat. */
  duplicateOf: { date: string; amount: string } | null;
}

export interface EditedMessage {
  messageId: number;
  before: string;
  after: string;
}

export interface KnownMessage {
  messageId: number;
  status: string;
  text: string;
}

export interface SortedExport {
  rows: WizardRow[];
  /** Messages seen for the first time, however many rows they gave. */
  newMessages: number;
  /** Imported earlier and changed since: only shown, the entry stays as it is. */
  edited: EditedMessage[];
  alreadyImported: number;
  /** Ignored earlier: among `rows`, waiting on "ignore" with a mark. */
  alreadySkipped: number;
  /** Left for review earlier, with the same text: restored by `restorePending`. */
  alreadyPending: number;
}

/** Leave out what has been imported. A message ignored earlier stays visible on
 *  "ignore", so the decision can be changed; if its text has changed since, it
 *  is sorted anew, as nothing was created from it. */
export function sortExport(
  messages: ExportMessage[],
  known: KnownMessage[],
  pending: TelegramPending[],
  currency: string,
): SortedExport {
  const byId = new Map(known.map((k) => [k.messageId, k]));
  const waiting = new Map(pending.map((p) => [p.messageId, p]));
  const rows: WizardRow[] = [];
  const edited: EditedMessage[] = [];
  let alreadyImported = 0;
  let alreadySkipped = 0;
  let alreadyPending = 0;
  let newMessages = 0;
  for (const m of messages) {
    const prior = byId.get(m.id);
    if (prior?.status === "imported") {
      alreadyImported += 1;
      if (prior.text !== m.text) edited.push({ messageId: m.id, before: prior.text, after: m.text });
      continue;
    }
    if (waiting.get(m.id)?.text === m.text) {
      alreadyPending += 1;
      continue;
    }
    const fresh = newRows(rows.length, m, currency);
    if (prior && prior.text === m.text) {
      alreadySkipped += 1;
      rows.push(...fresh.map((r): WizardRow => ({ ...r, bucket: "ignore", reasons: ["ignoredEarlier"] })));
      continue;
    }
    newMessages += 1;
    rows.push(...fresh);
  }
  return { rows, newMessages, edited, alreadyImported, alreadySkipped, alreadyPending };
}

function newRows(firstKey: number, m: ExportMessage, currency: string): WizardRow[] {
  return classifyMessage(m.text, currency).map((c, i) => ({
    key: firstKey + i,
    messageId: m.id,
    text: m.text,
    date: m.date,
    time: m.time,
    ...c,
    categoryId: null,
    duplicateOf: null,
  }));
}

/** The latest message on top. By message id, not by the date in the row: a row
 *  must not jump away while its date is being edited. Rows of one message keep
 *  their order. */
export function newestFirst<T extends { messageId: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.messageId - a.messageId);
}

/** A copy of the row right after it, to correct by hand: the same date and time,
 *  the same message, so together they are one message's entries. */
export function duplicateRow(rows: WizardRow[], key: number, newKey: number): WizardRow[] {
  const index = rows.findIndex((r) => r.key === key);
  if (index < 0) return rows;
  const copy: WizardRow = {
    ...rows[index],
    key: newKey,
    reasons: rows[index].reasons.filter((x) => x !== "possibleDuplicate"),
    duplicateOf: null,
  };
  return [...rows.slice(0, index + 1), copy, ...rows.slice(index + 1)];
}

/** The rows of messages left for review earlier, corrections included. `fresh`
 *  are the rows sorted from the file: a message there has changed its text, and
 *  its old draft no longer applies. Keys go on from `firstKey`. */
export function restorePending(
  pending: TelegramPending[],
  fresh: WizardRow[],
  currency: string,
  firstKey: number,
): WizardRow[] {
  const inFile = new Set(fresh.map((r) => r.messageId));
  const rows: WizardRow[] = [];
  for (const p of pending) {
    if (inFile.has(p.messageId)) continue;
    let draft: WizardRow[];
    try {
      draft = JSON.parse(p.rowsJson);
    } catch {
      draft = newRows(0, { id: p.messageId, date: p.date, time: p.time, text: p.text }, currency);
    }
    for (const r of draft) rows.push({ ...r, key: firstKey + rows.length });
  }
  return rows;
}

/** Local wall-clock time of the export and the chosen offset → UTC. */
export function toUtc(date: string, time: string, offset: string): string {
  return new Date(`${date}T${time}${offset}`).toISOString();
}

const MATCH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

function directionOf(r: WizardRow): CashDirection | null {
  if (r.bucket === "in" || r.bucket === "out") return r.bucket;
  return r.bucket === "review" ? "out" : null;
}

/** Rows that may repeat an entry already on the account (typed by hand, or
 *  created by "Find cash withdrawals") wait for a decision. One entry answers
 *  for one row. Entries from earlier imports do not count: those are known by
 *  their message id, and the same purchase twice is just two purchases. */
export function markDuplicates(rows: WizardRow[], existing: Transaction[], offset: string): WizardRow[] {
  const free = existing
    .filter((x) => x.importBatchId === null)
    .map((x) => {
      const incoming = Number(x.credit) > 0;
      return {
        at: new Date(x.occurredAtUtc).getTime(),
        direction: (incoming ? "in" : "out") as CashDirection,
        minor: parseMoneyToMinor(incoming ? x.credit : x.debit),
        date: x.occurredAtUtc.slice(0, 10),
        amount: incoming ? x.credit : x.debit,
        used: false,
      };
    });
  return rows.map((r) => {
    const direction = directionOf(r);
    const minor = parseMoneyToMinor(r.amount);
    if (!direction || !minor) return r;
    const at = new Date(toUtc(r.date, r.time, offset)).getTime();
    let best: (typeof free)[number] | null = null;
    for (const x of free) {
      if (x.used || x.direction !== direction || x.minor !== minor) continue;
      const gap = Math.abs(x.at - at);
      if (gap <= MATCH_WINDOW_MS && (!best || gap < Math.abs(best.at - at))) best = x;
    }
    if (!best) return r;
    best.used = true;
    return {
      ...r,
      bucket: "review" as Bucket,
      reasons: [...r.reasons, "possibleDuplicate" as Reason],
      duplicateOf: { date: best.date, amount: best.amount },
    };
  });
}

/** The keys from one row to another in the order shown, for a Shift-click. */
export function keysBetween(keys: number[], from: number, to: number): number[] {
  const a = keys.indexOf(from);
  const b = keys.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export function isInvalid(r: WizardRow): boolean {
  if (r.bucket !== "in" && r.bucket !== "out") return false;
  return !r.date || !r.time || !((parseMoneyToMinor(r.amount) ?? 0) > 0);
}

export interface PlannedEntry {
  occurredAtUtc: string;
  direction: CashDirection;
  amount: string;
  categoryId: number | null;
  comment: string | null;
}

export interface PlannedDecision {
  messageId: number;
  text: string;
  entries: PlannedEntry[];
}

export interface Plan {
  decisions: PlannedDecision[];
  /** Messages left in "review": saved with their rows, to be sorted out later. */
  pending: TelegramPending[];
}

/** What the rows amount to. A message with a part still in "review" waits as a
 *  whole, or its other parts would be imported and the rest never offered. */
export function planImport(rows: WizardRow[], offset: string): Plan {
  const byMessage = new Map<number, WizardRow[]>();
  for (const r of rows) {
    const group = byMessage.get(r.messageId);
    if (group) group.push(r);
    else byMessage.set(r.messageId, [r]);
  }
  const decisions: PlannedDecision[] = [];
  const pending: TelegramPending[] = [];
  for (const [messageId, group] of byMessage) {
    if (group.some((r) => r.bucket === "review")) {
      const { text, date, time } = group[0];
      pending.push({ messageId, text, date, time, rowsJson: JSON.stringify(group) });
      continue;
    }
    // Ignored earlier and still ignored: nothing to write, the old decision stands.
    if (group.every((r) => r.bucket === "ignore" && r.reasons.includes("ignoredEarlier"))) continue;
    decisions.push({
      messageId,
      text: group[0].text,
      entries: group
        .filter((r) => r.bucket === "in" || r.bucket === "out")
        .map((r) => ({
          // An empty date is reported by `isInvalid` and blocks the import.
          occurredAtUtc: isInvalid(r) ? "" : toUtc(r.date, r.time, offset),
          direction: r.bucket as CashDirection,
          amount: r.amount.trim().replace(/\s+/g, "").replace(",", "."),
          categoryId: r.categoryId,
          comment: r.comment.trim() || null,
        })),
    });
  }
  return { decisions, pending };
}
