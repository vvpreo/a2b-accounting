import { Fragment, useMemo } from "react";

import type { RateEntry } from "../lib/api";

interface Props {
  /** Stored rate entries (date + rate string), ASC by date. */
  entries: RateEntry[];
  /** BCP-47 locale code used for weekday header labels. */
  locale: string;
}

/**
 * Tabular weekly view of stored exchange rates.
 *
 * Layout (CSS Grid, not <table> — `position:sticky` on table cells is
 * unreliable in WebKit when several sticky stops are stacked):
 *  - `.rate-weeks` is the scroll container.
 *  - `.rate-weeks-header` sticks at top: 0.
 *  - `.rate-weeks-year` rows stick at top: header-h.
 *  - Each week is a 7-cell grid row with "DD.MM" + (optional) rate.
 *
 * When a week straddles a year boundary it is rendered TWICE — once under
 * each year — with the days that belong to the other year greyed out, so
 * each year section is visually self-contained.
 */
export function RateWeeksTable({ entries, locale }: Props) {
  const rateByDate = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) m.set(e.rateDate, e.rateToBase);
    return m;
  }, [entries]);

  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    const ref = new Date(2024, 0, 1); // Mon
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(ref);
      d.setDate(ref.getDate() + i);
      return fmt.format(d);
    });
  }, [locale]);

  const yearGroups = useMemo(() => {
    if (entries.length === 0) return [];
    const earliest = parseIsoDate(entries[0].rateDate);
    const latest = new Date();
    return buildYearGroups(earliest, latest);
  }, [entries]);

  if (yearGroups.length === 0) {
    return null;
  }

  return (
    <div className="rate-weeks">
      <div className="rate-weeks-header">
        {weekdayLabels.map((w, i) => (
          <div key={i} className="rate-weeks-header-cell">
            {w}
          </div>
        ))}
      </div>
      {yearGroups.map((group) => (
        <Fragment key={group.year}>
          <div className="rate-weeks-year">{group.year}</div>
          {group.weeks.map((week) => (
            <div
              key={`${week.mondayIso}-${group.year}`}
              className="rate-weeks-week"
            >
              {week.days.map((d) => {
                const rate = rateByDate.get(d.iso);
                const offYear = d.year !== group.year;
                const cls =
                  "rate-weeks-cell" +
                  (offYear ? " rate-weeks-cell--off-year" : "") +
                  (rate && !offYear ? " rate-weeks-cell--has-data" : "");
                return (
                  <div key={d.iso} className={cls} title={d.iso}>
                    <div className="rate-weeks-cell-date">{d.dayMonth}</div>
                    {rate && !offYear && (
                      <div className="rate-weeks-cell-rate">
                        {formatRate(rate)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

interface DayCell {
  iso: string;       // YYYY-MM-DD
  dayMonth: string;  // DD.MM
  year: number;      // calendar year of this exact day
}
interface WeekRow {
  mondayIso: string;
  days: DayCell[];   // length 7, Mon..Sun
}
interface YearGroup {
  year: number;
  weeks: WeekRow[];  // newest week first
}

function buildYearGroups(earliest: Date, latest: Date): YearGroup[] {
  const startMonday = mondayOf(earliest);
  const endMonday = mondayOf(latest);

  const groups = new Map<number, WeekRow[]>();
  const cursor = new Date(endMonday);
  while (cursor.getTime() >= startMonday.getTime()) {
    const week = makeWeekRow(cursor);
    const yearMon = week.days[0].year;
    const yearSun = week.days[6].year;

    appendWeek(groups, yearMon, week);
    if (yearSun !== yearMon) {
      // Boundary week — duplicate under the other year so each year section
      // contains its own copy with the foreign-year days greyed.
      appendWeek(groups, yearSun, week);
    }

    cursor.setDate(cursor.getDate() - 7);
  }

  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, weeks]) => ({ year, weeks }));
}

function appendWeek(
  groups: Map<number, WeekRow[]>,
  year: number,
  week: WeekRow,
): void {
  const list = groups.get(year);
  if (list) {
    list.push(week);
  } else {
    groups.set(year, [week]);
  }
}

function makeWeekRow(monday: Date): WeekRow {
  const days: DayCell[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push({
      iso: formatIso(d),
      dayMonth: formatDayMonth(d),
      year: d.getFullYear(),
    });
  }
  return { mondayIso: formatIso(monday), days };
}

function mondayOf(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const offsetToMon = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + offsetToMon);
  return d;
}

function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDayMonth(d: Date): string {
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}`;
}

/**
 * Compact rate rendering: keep ~4 significant digits so values stay readable
 * across very different magnitudes (1.05 USD/EUR vs 150 JPY/EUR vs 1500 KRW).
 */
function formatRate(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toPrecision(4).replace(/\.?0+$/, "");
}
