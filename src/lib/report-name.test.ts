import { describe, expect, it } from "vitest";

import { reportLabel } from "./report-name";

const t = (key: string) => key;

describe("reportLabel", () => {
  it("translates the names the app gave the report", () => {
    for (const name of ["ДДС", "Cash Flow", "Отчёт учёта", "Household report"]) {
      expect(reportLabel(name, t)).toEqual({ label: "tabs.report", title: "tabs.reportTooltip" });
    }
  });

  it("keeps the user's own name", () => {
    expect(reportLabel("Семейный бюджет", t)).toEqual({
      label: "Семейный бюджет",
      title: "Семейный бюджет",
    });
  });
});
