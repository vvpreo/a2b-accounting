import { useT } from "../i18n";

export type Tab = "categories" | "accounts" | "transactions" | "settings";

interface Props {
  active: Tab;
  onChange: (tab: Tab) => void;
}

export function Tabs({ active, onChange }: Props) {
  const t = useT();
  const main: Tab[] = ["accounts", "transactions"];
  const aside: Tab[] = ["categories", "settings"];

  return (
    <nav className="tabs">
      <div className="tabs-main">
        {main.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`tab-button${active === tab ? " active" : ""}`}
            onClick={() => onChange(tab)}
          >
            {t(`tabs.${tab}`)}
          </button>
        ))}
      </div>
      <div className="tabs-aside">
        {aside.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`tab-button${active === tab ? " active" : ""}`}
            onClick={() => onChange(tab)}
          >
            {t(`tabs.${tab}`)}
          </button>
        ))}
      </div>
    </nav>
  );
}
