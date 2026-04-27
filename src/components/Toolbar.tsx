import { useT } from "../i18n";

interface Props {
  expanded: boolean;
  onToggle: () => void;
  onCreateAccount: () => void;
  onImportTransactions: () => void;
}

export function Toolbar({
  expanded,
  onToggle,
  onCreateAccount,
  onImportTransactions,
}: Props) {
  const t = useT();

  if (!expanded) {
    return (
      <button
        type="button"
        className="global-toolbar-handle"
        onClick={onToggle}
        aria-label={t("toolbar.expand")}
        title={t("toolbar.expand")}
      >
        <span className="global-toolbar-handle-grip" />
      </button>
    );
  }

  return (
    <section className="global-toolbar">
      <div className="global-toolbar-content">
        <div className="global-toolbar-group">
          <button
            type="button"
            className="btn-primary"
            onClick={onCreateAccount}
          >
            {t("toolbar.createAccount")}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={onImportTransactions}
          >
            {t("toolbar.importTransactions")}
          </button>
        </div>
      </div>
      <button
        type="button"
        className="global-toolbar-collapse"
        onClick={onToggle}
        aria-label={t("toolbar.collapse")}
        title={t("toolbar.collapse")}
      >
        ▲
      </button>
    </section>
  );
}
