import { describe, expect, it } from "vitest";

import {
  COLUMN_WIDTH_FALLBACK,
  clampColumnWidth,
  parseColumnWidths,
  totalColumnWidth,
} from "./columnWidths";

describe("clampColumnWidth", () => {
  it("rounds and keeps the width within limits", () => {
    expect(clampColumnWidth(120.6)).toBe(121);
    expect(clampColumnWidth(1)).toBe(24);
    expect(clampColumnWidth(99999)).toBe(3000);
  });
});

describe("parseColumnWidths", () => {
  it("reads saved widths", () => {
    expect(parseColumnWidths('{"peer":300,"date":120}')).toEqual({
      peer: 300,
      date: 120,
    });
  });

  it("clamps saved values", () => {
    expect(parseColumnWidths('{"peer":1}')).toEqual({ peer: 24 });
  });

  it("drops unknown columns and non-numbers", () => {
    expect(parseColumnWidths('{"gone":300,"peer":"wide"}')).toEqual({});
  });

  it("treats a missing or broken value as no widths", () => {
    expect(parseColumnWidths(null)).toEqual({});
    expect(parseColumnWidths("")).toEqual({});
    expect(parseColumnWidths("{oops")).toEqual({});
    expect(parseColumnWidths("null")).toEqual({});
  });
});

describe("totalColumnWidth", () => {
  it("sums the given columns, with the fallback for those without a width", () => {
    expect(totalColumnWidth(["peer", "date"], { peer: 300, note: 999 })).toBe(
      300 + COLUMN_WIDTH_FALLBACK,
    );
  });
});
