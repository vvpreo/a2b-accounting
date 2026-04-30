import { useState } from "react";

import { clearAllData, seedDemoData } from "../lib/api";
import { LANGUAGES, LocaleCode, useI18n, useT } from "../i18n";

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

      <DemoDataSection />
      <DangerZoneSection />
    </section>
  );
}

function DemoDataSection() {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setError(null);
    setBusy(true);
    try {
      await seedDemoData();
      // Hard reload so every cached state (tab list, accounts, categories,
      // report views) re-fetches from the freshly seeded DB.
      window.location.reload();
    } catch (e) {
      setError(t("settings.demo.errorLoading", { message: String(e) }));
      setBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t("settings.demo.title")}</h3>
      <p className="settings-hint">{t("settings.demo.hint")}</p>
      {error && <div className="error">{error}</div>}
      {!confirming ? (
        <button
          type="button"
          className="btn-primary"
          onClick={() => setConfirming(true)}
          disabled={busy}
        >
          {t("settings.demo.button")}
        </button>
      ) : (
        <div className="danger-confirm">
          <p>{t("settings.demo.confirm")}</p>
          <div className="danger-confirm-actions">
            <button
              type="button"
              className="btn-danger"
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? t("settings.demo.loading") : t("settings.demo.confirmYes")}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DangerZoneSection() {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setError(null);
    setBusy(true);
    try {
      await clearAllData();
      window.location.reload();
    } catch (e) {
      setError(t("settings.dangerZone.errorClearing", { message: String(e) }));
      setBusy(false);
    }
  }

  return (
    <div className="settings-section settings-section--danger">
      <h3 className="settings-section-title">{t("settings.dangerZone.title")}</h3>
      <p className="settings-hint">{t("settings.dangerZone.hint")}</p>
      {error && <div className="error">{error}</div>}
      {!confirming ? (
        <button
          type="button"
          className="btn-danger-ghost"
          onClick={() => setConfirming(true)}
          disabled={busy}
        >
          {t("settings.dangerZone.button")}
        </button>
      ) : (
        <div className="danger-confirm">
          <p>{t("settings.dangerZone.confirm")}</p>
          <div className="danger-confirm-actions">
            <button
              type="button"
              className="btn-danger"
              onClick={onConfirm}
              disabled={busy}
            >
              {busy
                ? t("settings.dangerZone.clearing")
                : t("settings.dangerZone.confirmYes")}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
