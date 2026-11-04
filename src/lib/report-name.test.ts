import { describe, expect, it } from "vitest";

import { reportLabel } from "./report-name";

const t = (key: string) => key;

describe("reportLabel", () => {
  it("translates the names the app gave the report", () => {
    for (const name of ["ДДС", "Cash Flow", "Отчёт учёта", "Household report"]) {
      expect(reportLabel(name, t)).toEqual({ label: "tabs.report", title: "tabs.reportTooltip" });
    }
  });

  it("translates the waterfall's names", () => {
    for (const name of ["Водопад", "Waterfall"]) {
      expect(reportLabel(name, t)).toEqual({ label: "tabs.waterfall", title: "tabs.waterfallTooltip" });
    }
  });

  it("keeps the user's own name", () => {
    expect(reportLabel("Семейный бюджет", t)).toEqual({
      label: "Семейный бюджет",
      title: "Семейный бюджет",
    });
  });
});
