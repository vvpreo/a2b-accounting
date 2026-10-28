import { useEffect, useRef, useState } from "react";

import { useI18n, useT } from "../../i18n";

export interface PeriodPreset {
  /** i18n key suffix under `transactions.period.*`. */
  key: string;
  from: string;
  to: string;
}

interface Props {
  /** YYYY-MM-DD bounds of the current range. */
  from: string;
  to: string;
  presets: PeriodPreset[];
  onChange: (from: string, to: string) => void;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** First and last day (YYYY-MM-DD) of a month; `month` is 0-based. */
function monthBounds(year: number, month: number): { from: string; to: string } {
  const last = new Date(year, month + 1, 0).getDate();
  return { from: `${year}-${pad(month + 1)}-01`, to: `${year}-${pad(month + 1)}-${pad(last)}` };
}
/** Comparable month index. */
const monthKey = (year: number, month: number) => year * 12 + month;

/// One compact "Period" control instead of two date fields + preset buttons:
/// the button shows the active preset (or the range), the panel lists the
/// presets, a month grid and — last — a custom from/to pair applied with a
/// button.
///
/// Month grid: the first click picks one month, the next click extends the
/// selection to the clicked month (a continuous range, also across years —
/// switch the year with ‹ ›); the click after that starts a new selection.
export function PeriodDropdown({ from, to, presets, onChange }: Props) {
  const t = useT();
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);
  // The year shown in the month grid, and the first month of a selection
  // waiting for its second click.
  const [gridYear, setGridYear] = useState(() => Number((to || from).slice(0, 4)) || new Date().getFullYear());
  const [anchor, setAnchor] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const thisYear = new Date().getFullYear();

  // Opening always starts from the applied range.
  useEffect(() => {
    if (!open) {
      setCustomFrom(from);
      setCustomTo(to);
      setAnchor(null);
      setGridYear(Number((to || from).slice(0, 4)) || new Date().getFullYear());
    }
  }, [from, to, open]);

  function pickMonth(month: number) {
    const key = monthKey(gridYear, month);
    // The custom from/to fields below follow the picked months.
    const apply = (nextFrom: string, nextTo: string) => {
      onChange(nextFrom, nextTo);
      setCustomFrom(nextFrom);
      setCustomTo(nextTo);
    };
    if (anchor === null || anchor === key) {
      const b = monthBounds(gridYear, month);
      apply(b.from, b.to);
      setAnchor(key);
      return;
    }
    const [lo, hi] = anchor < key ? [anchor, key] : [key, anchor];
    apply(
      monthBounds(Math.floor(lo / 12), lo % 12).from,
      monthBounds(Math.floor(hi / 12), hi % 12).to,
    );
    setAnchor(null);
  }

  // A month is highlighted when it lies wholly inside the applied range.
  const inRange = (month: number) => {
    const b = monthBounds(gridYear, month);
    return (!from || from <= b.from) && (!to || b.to <= to) && (!!from || !!to);
  };
  const monthName = (month: number) =>
    new Date(2000, month, 1).toLocaleDateString(locale, { month: "short" }).replace(".", "");

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = presets.find((p) => p.from === from && p.to === to) ?? null;
  const formatDay = (d: string) =>
    d ? new Date(`${d}T00:00:00`).toLocaleDateString(locale) : "…";
  // Whole months read better as months: "Oct 2026", "Jan – Mar 2026".
  const wholeMonths =
    /^\d{4}-\d{2}-01$/.test(from) &&
    /^\d{4}-\d{2}-\d{2}$/.test(to) &&
    monthBounds(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1).to === to;
  const formatMonth = (d: string, withYear: boolean) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(locale, withYear ? { month: "short", year: "numeric" } : { month: "short" });
  const summary = active
    ? t(`transactions.period.${active.key}`)
    : wholeMonths
      ? from.slice(0, 7) === to.slice(0, 7)
        ? new Date(`${from}T00:00:00`).toLocaleDateString(locale, { month: "long", year: "numeric" })
        : `${formatMonth(from, from.slice(0, 4) !== to.slice(0, 4))} – ${formatMonth(to, true)}`
      : `${formatDay(from)} – ${formatDay(to)}`;

  return (
    <div className="dropdown" ref={wrapRef}>
      <button type="button" className="dropdown-button" onClick={() => setOpen((v) => !v)}>
        <span className="dropdown-button-text">{summary}</span>
      </button>
      {open && (
        <div className="dropdown-panel period-panel">
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`dropdown-item period-item${p === active ? " is-active" : ""}`}
              onClick={() => {
                onChange(p.from, p.to);
                setOpen(false);
              }}
            >
              <span className="period-check">{p === active ? "✓" : ""}</span>
              {t(`transactions.period.${p.key}`)}
            </button>
          ))}
          <div className="dropdown-divider" />
          <div className="period-months">
            <div className="period-months-head">
              <span className="period-custom-title">{t("transactions.period.months")}</span>
              <span className="period-months-year">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t("transactions.period.prevYear")}
                  onClick={() => setGridYear((y) => y - 1)}
                >
                  ‹
                </button>
                <span>{gridYear}</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t("transactions.period.nextYear")}
                  disabled={gridYear >= thisYear}
                  onClick={() => setGridYear((y) => y + 1)}
                >
                  ›
                </button>
              </span>
            </div>
            <div className="period-months-grid">
              {Array.from({ length: 12 }, (_, m) => (
                <button
                  key={m}
                  type="button"
                  className={[
                    "period-month",
                    inRange(m) ? "is-in-range" : "",
                    anchor === monthKey(gridYear, m) ? "is-anchor" : "",
                  ].join(" ")}
                  onClick={() => pickMonth(m)}
                >
                  {monthName(m)}
                </button>
              ))}
            </div>
            <span className="hint period-months-hint">
              {anchor !== null ? t("transactions.period.monthsHintSecond") : t("transactions.period.monthsHint")}
            </span>
          </div>
          <div className="dropdown-divider" />
          <div className="period-custom">
            <span className="period-custom-title">{t("transactions.period.custom")}</span>
            <label>
              <span>{t("transactions.filterDateFrom")}</span>
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            </label>
            <label>
              <span>{t("transactions.filterDateTo")}</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </label>
          </div>
          <div className="dropdown-actions">
            <button
              type="button"
              className="btn-primary dropdown-apply"
              onClick={() => {
                onChange(customFrom, customTo);
                setOpen(false);
              }}
            >
              {t("transactions.applyButton")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
