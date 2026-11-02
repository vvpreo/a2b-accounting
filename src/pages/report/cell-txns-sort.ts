import type { CellTransaction } from "../../lib/api";

export type CellSortKey = "date" | "amount" | "peer";
export type CellSortDir = "asc" | "desc";
export interface CellSort {
  key: CellSortKey;
  dir: CellSortDir;
}

export const DEFAULT_CELL_SORT: CellSort = { key: "date", dir: "asc" };

/** Next sort after a click on a column header: the active column flips, another
 *  one starts from its most useful end — the largest amount first, peers A→Z,
 *  dates oldest first as in the default list. */
export function nextCellSort(current: CellSort, key: CellSortKey): CellSort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: key === "amount" ? "desc" : "asc" };
}

function byDate(a: CellTransaction, b: CellTransaction): number {
  return a.occurredAtUtc.localeCompare(b.occurredAtUtc) || a.id - b.id;
}

/** A sorted copy. Rows without a peer stay at the end in either direction; equal
 *  values keep date order. */
export function sortCellTransactions(
  rows: CellTransaction[],
  { key, dir }: CellSort,
  locale: string,
): CellTransaction[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "amount") return sign * (a.shareMinor - b.shareMinor) || byDate(a, b);
    if (key === "peer") {
      const peerA = a.peer?.trim() ?? "";
      const peerB = b.peer?.trim() ?? "";
      if (!peerA || !peerB) return Number(!peerA) - Number(!peerB) || byDate(a, b);
      return sign * peerA.localeCompare(peerB, locale) || byDate(a, b);
    }
    return sign * byDate(a, b);
  });
}
