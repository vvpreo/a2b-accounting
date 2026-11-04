import { RangePreset, ReportRange } from "../../lib/api";
import { PeriodPreset } from "../transactions/PeriodDropdown";

// Period dropdown preset key (see PeriodDropdown) ↔ the persisted preset.
const PRESET_BY_KEY: Record<string, Exclude<RangePreset, "custom">> = {
  "1": "months_1",
  "3": "months_3",
  "6": "months_6",
  "12": "months_12",
  "36": "months_36",
  all: "all_time",
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function lastDayOfMonth(year: number, monthOneIndexed: number): number {
  return new Date(year, monthOneIndexed, 0).getDate();
}


export function resolveRange(
  range: ReportRange,
  // Earliest transaction date for the active account selection. When the
  // "all_time" preset is chosen we anchor `from` here so the report doesn't
  // start at 1970 and pad with thousands of empty periods. `null` while still
  // loading or when there are no transactions — fallback to a small window
  // around today instead of 1970.
  earliestTxnDate: string | null,
): { from: string; to: string } | null {
  if (range.kind === "custom") return { from: range.from, to: range.to };
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  const todayStr = isoDate(y, m, today.getDate());
  // Cap any built-in preset's upper bound at today — there's no point
  // padding the report with empty future periods (May–Dec when we're in
  // April), and the user can always switch to "custom" to look ahead.
  const capToToday = (to: string): string => (to > todayStr ? todayStr : to);
  switch (range.preset) {
    case "months_1":
    case "months_3":
    case "months_6":
    case "months_12":
    case "months_36":
    // Older reports: shown and resolved as "12", like the Transactions screen.
    case "last_12_months": {
      const back = range.preset === "last_12_months" ? 12 : Number(range.preset.slice("months_".length));
      const start = new Date(y, m - 1 - back, 1);
      return {
        from: isoDate(start.getFullYear(), start.getMonth() + 1, 1),
        to: capToToday(isoDate(y, m, lastDayOfMonth(y, m))),
      };
    }
    case "current_month":
      return {
        from: isoDate(y, m, 1),
        to: capToToday(isoDate(y, m, lastDayOfMonth(y, m))),
      };
    case "current_quarter": {
      const qStart = Math.floor((m - 1) / 3) * 3 + 1;
      const qEnd = qStart + 2;
      return {
        from: isoDate(y, qStart, 1),
        to: capToToday(isoDate(y, qEnd, lastDayOfMonth(y, qEnd))),
      };
    }
    case "current_year":
      return { from: isoDate(y, 1, 1), to: capToToday(isoDate(y, 12, 31)) };
    case "all_time": {
      if (earliestTxnDate === null) {
        // Hold off computing the report until we know where the data starts.
        // Returning null here means the effect skips the computeReport call;
        // it'll re-run when earliestTxnDate arrives.
        return null;
      }
      return { from: earliestTxnDate, to: todayStr };
    }
  }
}

// The period dropdown works with from/to; a range equal to one of its
// presets is stored as that (rolling) preset, anything else as custom.
// "last_12_months" of older reports is the same range as "12".
function presetKeyOf(preset: RangePreset) {
  return preset === "last_12_months"
    ? "12"
    : Object.keys(PRESET_BY_KEY).find((k) => PRESET_BY_KEY[k] === preset);
}

/** The from/to the period dropdown shows for a stored range. */
export function reportPeriodBounds(
  range: ReportRange,
  presets: PeriodPreset[],
  earliestTxnDate: string | null,
): { from: string; to: string } {
  if (range.kind === "custom") return { from: range.from, to: range.to };
  const p = presets.find((x) => x.key === presetKeyOf(range.preset));
  if (p) return { from: p.from, to: p.to };
  return resolveRange(range, earliestTxnDate) ?? { from: "", to: "" };
}

/** The range to store for a choice in the period dropdown, if it is complete. */
export function reportRangeFromPeriod(
  from: string,
  to: string,
  presets: PeriodPreset[],
): ReportRange | null {
  const p = presets.find((x) => x.from === from && x.to === to);
  if (p) return { kind: "preset", preset: PRESET_BY_KEY[p.key] };
  if (from && to) return { kind: "custom", from: from <= to ? from : to, to: from <= to ? to : from };
  return null;
}
