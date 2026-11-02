type Translate = (key: string) => string;

// Names the app itself gave the report, current and past, in any language.
// They are stored in the DB but shown translated; anything else is the user's
// own name and is shown as typed.
const DEFAULT_REPORT_NAMES = new Set(["ДДС", "Cash Flow", "Отчёт учёта", "Household report"]);

/** The tab text and tooltip for a report with this stored name. */
export function reportLabel(name: string, t: Translate): { label: string; title: string } {
  if (DEFAULT_REPORT_NAMES.has(name)) {
    return { label: t("tabs.report"), title: t("tabs.reportTooltip") };
  }
  return { label: name, title: name };
}
