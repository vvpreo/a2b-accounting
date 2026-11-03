import { useT } from "../i18n";
import { isRegular, toggleRegular } from "../lib/regular-payments";

/// Under a cash entry's comment: puts the regular mark in front of the text or
/// takes it off. It only changes the field — the form's Save writes it.
export function RegularToggle({ comment, onChange }: { comment: string; onChange: (comment: string) => void }) {
  const t = useT();
  const regular = isRegular(comment);
  return (
    <button
      type="button"
      className="btn-ghost regular-toggle"
      aria-pressed={regular}
      title={t(regular ? "accounts.cash.regular.unmarkHint" : "accounts.cash.regular.markHint")}
      onClick={() => onChange(toggleRegular(comment))}
    >
      {t(regular ? "accounts.cash.regular.unmark" : "accounts.cash.regular.mark")}
    </button>
  );
}
