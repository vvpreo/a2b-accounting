import { useT } from "../i18n";
import { Account } from "../lib/api";

interface Props {
  accounts: Account[];
  selected: number[];
  onChange: (ids: number[]) => void;
}

export function AccountChips({ accounts, selected, onChange }: Props) {
  const t = useT();
  const allActive = selected.length === 0;

  function toggle(id: number) {
    if (selected.includes(id)) {
      onChange(selected.filter((x) => x !== id));
    } else {
      onChange([...selected, id]);
    }
  }

  return (
    <div className="account-chips">
      <button
        type="button"
        className={`chip${allActive ? " active" : ""}`}
        onClick={() => onChange([])}
      >
        {t("transactions.filterAll")}
      </button>
      {accounts.map((a) => {
        const isActive = selected.includes(a.id);
        return (
          <button
            key={a.id}
            type="button"
            className={`chip${isActive ? " active" : ""}`}
            onClick={() => toggle(a.id)}
          >
            {a.name || a.accountNumber} · {a.currency}
          </button>
        );
      })}
    </div>
  );
}
