import { describe, expect, it } from "vitest";

import { indexAfterKey, indexByTyping } from "./select-navigation";

describe("indexAfterKey", () => {
  it("moves and stops at the ends", () => {
    expect(indexAfterKey("ArrowDown", 0, 3)).toBe(1);
    expect(indexAfterKey("ArrowDown", 2, 3)).toBe(2);
    expect(indexAfterKey("ArrowUp", 0, 3)).toBe(0);
    expect(indexAfterKey("Home", 2, 3)).toBe(0);
    expect(indexAfterKey("End", 0, 3)).toBe(2);
  });

  it("ignores other keys and an empty list", () => {
    expect(indexAfterKey("a", 0, 3)).toBeNull();
    expect(indexAfterKey("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("indexByTyping", () => {
  const labels = ["AUD", "EUR", "THB", "TRY", "USD"];

  it("finds by the typed start, in any case", () => {
    expect(indexByTyping(labels, "us", 0)).toBe(4);
    expect(indexByTyping(labels, "TR", 0)).toBe(3);
  });

  it("a repeated letter walks through the matches and wraps", () => {
    expect(indexByTyping(labels, "t", 0)).toBe(2);
    expect(indexByTyping(labels, "tt", 2)).toBe(3);
    expect(indexByTyping(labels, "t", 3)).toBe(2);
  });

  it("no match, no move", () => {
    expect(indexByTyping(labels, "z", 0)).toBeNull();
    expect(indexByTyping(labels, "", 0)).toBeNull();
  });
});
