// Pure logic of the "Regular payments" wizard on a cash account: an entry is
// regular when its comment starts with the mark, and a month holds at most one
// payment per text — so the comment's text is the payment's identity.

import { Transaction } from "./api";

export const REGULAR_MARK = "🔄";

export function isRegular(comment: string | null | undefined): boolean {
  return (comment ?? "").trim().startsWith(REGULAR_MARK);
}

/** The comment's text after the mark: case and extra spaces do not matter. */
export function regularKey(comment: string | null | undefined): string {
  return (comment ?? "")
    .trim()
    .slice(REGULAR_MARK.length)
    .replace(/️/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Mark the comment as regular or take the mark off, with its space. */
export function toggleRegular(comment: string): string {
  const text = comment.trim();
  if (isRegular(text)) return text.slice(REGULAR_MARK.length).replace(/^\uFE0F/, "").trimStart();
  return `${REGULAR_MARK} ${text}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM` of a moment in the owner's time zone. */
export function monthOf(moment: string | Date): string {
  const d = new Date(moment);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const d = new Date(year, monthNumber - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function firstDayOf(month: string): string {
  return `${month}-01`;
}

/** The month's regular entries, oldest first. */
export function regularsIn(txns: Transaction[], month: string): Transaction[] {
  return txns
    .filter((x) => isRegular(x.comment) && monthOf(x.occurredAtUtc) === month)
    .sort((a, b) => a.occurredAtUtc.localeCompare(b.occurredAtUtc) || a.id - b.id);
}

/** The nearest month before `target` that has regular entries; the previous
 *  month when there is none. */
export function defaultSourceMonth(txns: Transaction[], target: string): string {
  const months = txns
    .filter((x) => isRegular(x.comment))
    .map((x) => monthOf(x.occurredAtUtc))
    .filter((m) => m < target)
    .sort();
  return months[months.length - 1] ?? shiftMonth(target, -1);
}

export interface PlannedPayment {
  source: Transaction;
  /** Entries with this text in the source month; the first one is taken. */
  sameTextInSource: number;
}

export interface RegularPlan {
  existing: Transaction[];
  toCreate: PlannedPayment[];
}

/** What the target month has and what the source month would add: one payment
 *  per text, nothing for a text the target month already has. */
export function planRegular(txns: Transaction[], target: string, source: string): RegularPlan {
  const existing = regularsIn(txns, target);
  const taken = new Set(existing.map((x) => regularKey(x.comment)));
  const byKey = new Map<string, PlannedPayment>();
  for (const x of regularsIn(txns, source)) {
    const key = regularKey(x.comment);
    if (taken.has(key)) continue;
    const planned = byKey.get(key);
    if (planned) planned.sameTextInSource += 1;
    else byKey.set(key, { source: x, sameTextInSource: 1 });
  }
  return { existing, toCreate: [...byKey.values()] };
}

/** The source month's first entry per text, to show where an entry already in
 *  the target month differs from it. */
export function sourceByText(txns: Transaction[], source: string): Map<string, Transaction> {
  const byKey = new Map<string, Transaction>();
  for (const x of regularsIn(txns, source)) {
    const key = regularKey(x.comment);
    if (!byKey.has(key)) byKey.set(key, x);
  }
  return byKey;
}

export interface CategoryShare {
  categoryId: number;
  shareMinor: number;
}

/** Carry category shares over to a corrected amount, keeping the proportions.
 *  A fully categorized entry stays fully categorized; shares rounded down to
 *  nothing are dropped. */
export function scaleShares(shares: CategoryShare[], from: number, to: number): CategoryShare[] {
  if (from === to) return shares;
  if (from <= 0 || to <= 0 || shares.length === 0) return [];
  const sum = shares.reduce((acc, s) => acc + s.shareMinor, 0);
  const scaled = shares.map((s) => ({ ...s, shareMinor: Math.floor((s.shareMinor * to) / from) }));
  if (sum === from) {
    const assigned = scaled.reduce((acc, s) => acc + s.shareMinor, 0);
    scaled[scaled.length - 1].shareMinor += to - assigned;
  }
  return scaled.filter((s) => s.shareMinor > 0);
}
