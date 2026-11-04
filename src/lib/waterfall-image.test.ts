import { describe, expect, it } from "vitest";

import { wrapText } from "./waterfall-image";

// One unit per character keeps the expectations readable.
const measure = (s: string) => s.length;

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
