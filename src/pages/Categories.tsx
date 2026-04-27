import { useT } from "../i18n";

export function CategoriesPage() {
  const t = useT();
  return (
    <section className="page">
      <p className="hint">{t("categories.tbd")}</p>
    </section>
  );
}
