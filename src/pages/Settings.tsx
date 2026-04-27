import { LANGUAGES, LocaleCode, useI18n } from "../i18n";

export function SettingsPage() {
  const { t, locale, setLocale } = useI18n();

  return (
    <section className="page">
      <div className="settings-row">
        <label htmlFor="settings-language">{t("settings.language")}</label>
        <select
          id="settings-language"
          value={locale}
          onChange={(e) => setLocale(e.target.value as LocaleCode)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
