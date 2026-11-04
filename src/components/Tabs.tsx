import { ReportView } from "../lib/api";
import { reportLabel } from "../lib/report-name";
import { useT } from "../i18n";

export type StaticTab =
  | "guide"
  | "context"
  | "documents"
  | "categories"
  | "accounts"
  | "transactions"
  | "settings";

export type Tab = StaticTab | { kind: "report"; id: number };

export function tabKey(tab: Tab): string {
  return typeof tab === "string" ? tab : `report:${tab.id}`;
}

export function tabsEqual(a: Tab, b: Tab): boolean {
  return tabKey(a) === tabKey(b);
}

interface Props {
  active: Tab;
  reportViews: ReportView[];
  onChange: (tab: Tab) => void;
}

export function Tabs({ active, reportViews, onChange }: Props) {
  const t = useT();
  const main: StaticTab[] = ["accounts", "transactions"];
  const aside: StaticTab[] = ["context", "documents", "categories", "settings"];
  const activeKey = tabKey(active);

  return (
    <nav className="tabs">
      <div className="tabs-main">
        <button
          type="button"
          className={`tab-button tab-button--icon${activeKey === "guide" ? " active" : ""}`}
          onClick={() => onChange("guide")}
          title={t("tabs.guide")}
          aria-label={t("tabs.guide")}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <circle cx="9" cy="9" r="7.75" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="9" cy="5.5" r="1" fill="currentColor" />
            <path d="M9 8.25v5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          </svg>
        </button>
        {main.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`tab-button${activeKey === tab ? " active" : ""}`}
            onClick={() => onChange(tab)}
          >
            {t(`tabs.${tab}`)}
          </button>
        ))}
        {reportViews.length > 0 && <span className="tabs-divider" aria-hidden="true" />}
        {reportViews.map((view) => {
          const key = `report:${view.id}`;
          return (
            <button
              key={key}
              type="button"
              className={`tab-button tab-button--report${activeKey === key ? " active" : ""}`}
              onClick={() => onChange({ kind: "report", id: view.id })}
              title={reportLabel(view.name, t).title}
            >
              {reportLabel(view.name, t).label}
            </button>
          );
        })}
      </div>
      <div className="tabs-aside">
        {aside.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`tab-button${activeKey === tab ? " active" : ""}`}
            onClick={() => onChange(tab)}
          >
            {t(`tabs.${tab}`)}
          </button>
        ))}
      </div>
    </nav>
  );
}
