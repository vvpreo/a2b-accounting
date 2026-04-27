import { useT } from "../i18n";

export type Tab = "categories" | "accounts" | "transactions" | "settings";

interface Props {
  active: Tab;
  onChange: (tab: Tab) => void;
}

export function Tabs({ active, onChange }: Props) {
  const t = useT();
  const main: Tab[] = ["categories", "accounts", "transactions"];

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
      <button
        type="button"
        className={`tab-button${active === "settings" ? " active" : ""}`}
        onClick={() => onChange("settings")}
      >
        {t("tabs.settings")}
      </button>
    </nav>
  );
}
