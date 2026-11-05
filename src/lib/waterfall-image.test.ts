import { describe, expect, it } from "vitest";

import { wrapText, wrapWhole } from "./waterfall-image";

// One unit per character keeps the expectations readable.
const measure = (s: string) => s.length;

describe("wrapWhole", () => {
  it("keeps every word, however many lines it takes", () => {
    expect(wrapWhole("one two three four five six", 5, measure)).toEqual(["one", "two", "three", "four", "five", "six"]);
  });

  it("puts words together while they fit", () => {
    expect(wrapWhole("Rates and adjustments", 11, measure)).toEqual(["Rates and", "adjustments"]);
  });

  it("splits a word wider than the line instead of cutting it", () => {
    expect(wrapWhole("Superlongcategory x", 6, measure)).toEqual(["Superl", "ongcat", "egory", "x"]);
  });

  it("survives an empty label", () => {
    expect(wrapWhole("", 10, measure)).toEqual([]);
  });
});

describe("wrapText", () => {
  it("keeps a short label on one line", () => {
    expect(wrapText("Housing", 20, 3, measure)).toEqual(["Housing"]);
  });

  it("breaks between words", () => {
    expect(wrapText("Rates and adjustments", 10, 3, measure)).toEqual(["Rates and", "adjustment…"].map((s) => (s.length > 10 ? "adjustmen…" : s)));
  });

  it("cuts what doesn't fit into the allowed lines", () => {
    const lines = wrapText("one two three four five six", 5, 2, measure);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.length <= 6)).toBe(true);
  });

  it("cuts a single word wider than the line", () => {
    expect(wrapText("Superlongcategory", 6, 3, measure)).toEqual(["Super…"]);
  });

  it("survives an empty label", () => {
    expect(wrapText("", 10, 2, measure)).toEqual([]);
  });
});
