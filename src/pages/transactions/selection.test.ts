import { describe, expect, it } from "vitest";

import { rangeIds } from "./selection";

describe("rangeIds", () => {
  const order = [10, 20, 30, 40, 50];

  it("returns the inclusive range when anchor precedes target", () => {
    expect(rangeIds(order, 20, 40)).toEqual([20, 30, 40]);
  });

  it("is order-independent (anchor after target)", () => {
    expect(rangeIds(order, 40, 20)).toEqual([20, 30, 40]);
  });

  it("returns a single id when anchor equals target", () => {
    expect(rangeIds(order, 30, 30)).toEqual([30]);
  });

  it("falls back to just the target when there is no anchor", () => {
    expect(rangeIds(order, null, 30)).toEqual([30]);
  });

  it("falls back to just the target when the anchor is no longer visible", () => {
    expect(rangeIds(order, 999, 30)).toEqual([30]);
  });

  it("returns empty when the target itself is not visible", () => {
    expect(rangeIds(order, 20, 999)).toEqual([]);
  });

  it("spans the full list from first to last", () => {
    expect(rangeIds(order, 10, 50)).toEqual([10, 20, 30, 40, 50]);
  });
});
