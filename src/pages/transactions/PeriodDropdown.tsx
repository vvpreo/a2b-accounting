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

/// One compact "Period" control instead of two date fields + preset buttons:
/// the button shows the active preset (or the custom range), the panel lists
/// the presets and a custom from/to pair applied with a button.
export function PeriodDropdown({ from, to, presets, onChange }: Props) {
  const t = useT();
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(from);
  const [customTo, setCustomTo] = useState(to);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Opening always starts from the applied range.
  useEffect(() => {
    if (!open) {
      setCustomFrom(from);
      setCustomTo(to);
    }
  }, [from, to, open]);

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
  const summary = active
    ? t(`transactions.period.${active.key}`)
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
