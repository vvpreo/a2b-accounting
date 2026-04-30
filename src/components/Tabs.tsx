import { ReportView } from "../lib/api";
import { useT } from "../i18n";

export type StaticTab =
  | "categories"
  | "accounts"
  | "transactions"
  | "settings"
  | "reports_builder";

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
  const aside: StaticTab[] = ["categories", "reports_builder", "settings"];
  const activeKey = tabKey(active);

  return (
    <nav className="tabs">
      <div className="tabs-main">
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
        {reportViews.map((view) => {
          const key = `report:${view.id}`;
          return (
            <button
              key={key}
              type="button"
              className={`tab-button tab-button--report${activeKey === key ? " active" : ""}`}
              onClick={() => onChange({ kind: "report", id: view.id })}
              title={view.name}
            >
              {view.name}
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
