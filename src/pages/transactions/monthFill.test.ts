import { describe, expect, it } from "vitest";

import { monthFillAt, monthStartMs } from "./monthFill";

const at = (month: number, day: number, hour = 0) =>
  new Date(2025, month - 1, day, hour).getTime();

// June has 30 days, so day boundaries are easy to read as fractions.
const JUNE = at(6, 1);
const JULY = at(7, 1);
const LATER = at(9, 15);

describe("monthStartMs", () => {
  it("returns the first moment of the local month", () => {
    expect(monthStartMs(at(6, 16, 13))).toBe(JUNE);
    expect(monthStartMs(JUNE)).toBe(JUNE);
  });
});

describe("monthFillAt", () => {
  it("is empty at the month's separator", () => {
    const { month, fill } = monthFillAt(JUNE, at(6, 4), 0, LATER);
    expect(month).toBe(JUNE);
    expect(fill).toBe(0);
  });

  it("shows the row's place in the calendar month", () => {
    expect(monthFillAt(at(6, 16), at(6, 20), 0, LATER).fill).toBeCloseTo(0.5);
  });

  it("interpolates towards the next row while the edge crosses a row", () => {
    expect(monthFillAt(at(6, 16), at(6, 22), 0.5, LATER).fill).toBeCloseTo(
      18 / 30,
    );
  });

  it("closes a month whose transactions stop mid-month once a later month follows", () => {
    expect(monthFillAt(at(6, 10), JULY, 0, LATER).fill).toBeCloseTo(9 / 30);
    expect(monthFillAt(at(6, 10), JULY, 0.5, LATER).fill).toBeCloseTo(
      (9 + 21 / 2) / 30,
    );
    expect(monthFillAt(at(6, 10), JULY, 1, LATER).fill).toBeCloseTo(1);
  });

  it("closes the last listed month when the calendar month is over", () => {
    expect(monthFillAt(at(6, 10), null, 1, LATER).fill).toBeCloseTo(1);
  });

  it("keeps the current month at its last transaction's date", () => {
    const now = at(6, 20);
    expect(monthFillAt(at(6, 16), null, 1, now).fill).toBeCloseTo(0.5);
  });
});
