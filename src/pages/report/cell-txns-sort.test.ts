import { describe, expect, it } from "vitest";

import type { CellTransaction } from "../../lib/api";
import { DEFAULT_CELL_SORT, nextCellSort, sortCellTransactions } from "./cell-txns-sort";

function row(id: number, day: number, shareMinor: number, peer: string | null): CellTransaction {
  return {
    id,
    accountId: 1,
    occurredAtUtc: `2026-01-0${day}T10:00:00Z`,
    credit: "0.00",
    debit: "0.00",
    balance: "0.00",
    peer,
    bankDescription: null,
    comment: null,
    memo: null,
    isCorrecting: false,
    shareMinor,
  };
}

const rows = [row(1, 1, 300, "Bravo"), row(2, 2, 100, null), row(3, 3, 300, "alpha"), row(4, 4, 200, " ")];
const ids = (key: "date" | "amount" | "peer", dir: "asc" | "desc") =>
  sortCellTransactions(rows, { key, dir }, "en").map((r) => r.id);

describe("sortCellTransactions", () => {
  it("sorts by date both ways", () => {
    expect(ids("date", "asc")).toEqual([1, 2, 3, 4]);
    expect(ids("date", "desc")).toEqual([4, 3, 2, 1]);
  });

  it("sorts by amount both ways, equal amounts in date order", () => {
    expect(ids("amount", "asc")).toEqual([2, 4, 1, 3]);
    expect(ids("amount", "desc")).toEqual([1, 3, 4, 2]);
  });

  it("sorts by peer ignoring case, rows without a peer always last", () => {
    expect(ids("peer", "asc")).toEqual([3, 1, 2, 4]);
    expect(ids("peer", "desc")).toEqual([1, 3, 2, 4]);
  });

  it("does not change the source list", () => {
    ids("amount", "desc");
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });
});

describe("nextCellSort", () => {
  it("flips the active column", () => {
    expect(nextCellSort(DEFAULT_CELL_SORT, "date")).toEqual({ key: "date", dir: "desc" });
  });

  it("starts each column from its useful end", () => {
    expect(nextCellSort(DEFAULT_CELL_SORT, "amount")).toEqual({ key: "amount", dir: "desc" });
    expect(nextCellSort(DEFAULT_CELL_SORT, "peer")).toEqual({ key: "peer", dir: "asc" });
    expect(nextCellSort({ key: "amount", dir: "desc" }, "date")).toEqual(DEFAULT_CELL_SORT);
  });
});
