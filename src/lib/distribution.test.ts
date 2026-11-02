import { describe, expect, it } from "vitest";

import { addEqualToCategorized, removeAt } from "./distribution";

describe("addEqualToCategorized", () => {
  it("gives the whole amount to the first category of an uncategorized transaction", () => {
    expect(addEqualToCategorized([1000], 1000)).toEqual([1000, 0]);
  });

  it("replacing the only category keeps the whole amount categorized", () => {
    const afterRemove = removeAt([1000, 0], 0, 1000);
    expect(afterRemove).toEqual([1000]);
    expect(addEqualToCategorized(afterRemove, 1000)).toEqual([1000, 0]);
  });

  it("splits the categorized pool evenly and leaves uncategorized alone", () => {
    expect(addEqualToCategorized([600, 400], 1000)).toEqual([300, 300, 400]);
    expect(addEqualToCategorized([1001, 0], 1001)).toEqual([501, 500, 0]);
  });
});
