import { describe, expect, it } from "vitest";

import en from "../i18n/locales/en.json";
import ru from "../i18n/locales/ru.json";
import { GUIDE_STEPS } from "./guide-steps";

type Texts = Record<string, Record<string, string>>;

describe("GUIDE_STEPS", () => {
  for (const [name, locale] of [["ru", ru], ["en", en]] as const) {
    it(`has all texts in ${name}`, () => {
      const steps = locale.guide.steps as Texts;
      for (const step of GUIDE_STEPS) {
        expect(steps[step.id]?.title, step.id).toBeTruthy();
        expect(steps[step.id]?.body, step.id).toBeTruthy();
        expect(steps[step.id]?.done, step.id).toBeTruthy();
        expect(Boolean(steps[step.id]?.warning), step.id).toBe(Boolean(step.warning));
      }
      expect(Object.keys(steps).sort()).toEqual(GUIDE_STEPS.map((s) => s.id).sort());
    });
  }
});
