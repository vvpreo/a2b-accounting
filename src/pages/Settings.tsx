import { useEffect, useRef, useState } from "react";

import {
  clearAllData,
  DataDirInfo,
  dataDirInfo,
  fetchBackupBlob,
  restoreFromZip,
  seedDemoData,
  triggerDownload,
} from "../lib/api";
import { LANGUAGES, LocaleCode, useI18n, useT } from "../i18n";
import { ThemeMode, useTheme } from "../theme";
import { CurrenciesTab } from "./settings/CurrenciesTab";
import { AiProviderTab } from "./settings/AiProviderTab";

type SettingsTab = "general" | "currencies" | "ai";

export function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  const { mode, setMode } = useTheme();
  const [tab, setTab] = useState<SettingsTab>("general");

  return (
    <section className="page">
      <div className="settings-tabs">
        <button
          type="button"
          className={
            "settings-tab-button" + (tab === "general" ? " active" : "")
          }
          onClick={() => setTab("general")}
        >
          {t("settings.tabs.general")}
        </button>
        <button
          type="button"
          className={
            "settings-tab-button" + (tab === "currencies" ? " active" : "")
          }
          onClick={() => setTab("currencies")}
        >
          {t("settings.tabs.currencies")}
        </button>
        <button
          type="button"
          className={"settings-tab-button" + (tab === "ai" ? " active" : "")}
          onClick={() => setTab("ai")}
        >
          {t("settings.tabs.ai")}
        </button>
      </div>

      {tab === "general" && (
        <>
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

          <div className="settings-row">
            <label htmlFor="settings-theme">{t("settings.theme")}</label>
            <select
              id="settings-theme"
              value={mode}
              onChange={(e) => setMode(e.target.value as ThemeMode)}
            >
              <option value="light">{t("settings.themeLight")}</option>
              <option value="dark">{t("settings.themeDark")}</option>
              <option value="system">{t("settings.themeSystem")}</option>
            </select>
          </div>

          <BackupSection />
          <DataDirSection />
          <DemoDataSection />
          <DangerZoneSection />
        </>
      )}

      {tab === "currencies" && <CurrenciesTab />}

      {tab === "ai" && <AiProviderTab />}
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

// Localise a stable error code returned by the Rust backup commands. Falls
// back to the raw message when it doesn't match a known code so unknown
// failures are still surfaced rather than silently hidden.
function localizeBackupError(
  raw: string,
  t: ReturnType<typeof useT>,
  prefix: "settings.backup.errorCodes" | "settings.dataDir.errorCodes",
): string {
  const code = raw.trim();
  const key = `${prefix}.${code}`;
  const localised = t(key);
  if (localised !== key) return localised;
  // The code may be prefixed with extra context after a colon (e.g.
  // "set_data_dir.create_dir: permission denied"). Try the bare prefix.
  const colon = code.indexOf(":");
  if (colon > 0) {
    const bare = code.slice(0, colon);
    const bareKey = `${prefix}.${bare}`;
    const bareLocalised = t(bareKey);
    if (bareLocalised !== bareKey) {
      const detail = code.slice(colon + 1).trim();
      return detail ? `${bareLocalised} (${detail})` : bareLocalised;
    }
  }
  return raw;
}

function BackupSection() {
  const t = useT();
  const [busy, setBusy] = useState<"backup" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pendingRestoreFile, setPendingRestoreFile] = useState<File | null>(
    null,
  );
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  async function handleBackup() {
    setError(null);
    setSuccess(null);
    setBusy("backup");
    try {
      const { blob, filename } = await fetchBackupBlob();
      triggerDownload(blob, filename);
      setSuccess(t("settings.backup.backupSuccess", { path: filename }));
    } catch (e) {
      setError(
        t("settings.backup.backupError", {
          message: localizeBackupError(String(e), t, "settings.backup.errorCodes"),
        }),
      );
    } finally {
      setBusy(null);
    }
  }

  function handleRestorePick() {
    setError(null);
    setSuccess(null);
    restoreInputRef.current?.click();
  }

  function onRestoreFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    // Reset the input so picking the same file again re-triggers onChange.
    e.target.value = "";
    if (file) setPendingRestoreFile(file);
  }

  async function confirmRestore() {
    if (!pendingRestoreFile) return;
    setBusy("restore");
    setError(null);
    try {
      await restoreFromZip(pendingRestoreFile);
      // The backend has already reopened the restored DB — a full reload
      // re-fetches every cached state from it.
      window.location.reload();
    } catch (e) {
      setError(
        t("settings.backup.restoreError", {
          message: localizeBackupError(String(e), t, "settings.backup.errorCodes"),
        }),
      );
      setBusy(null);
      setPendingRestoreFile(null);
    }
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t("settings.backup.title")}</h3>
      <p className="settings-hint">{t("settings.backup.hint")}</p>
      {error && <div className="error">{error}</div>}
      {success && <p className="settings-hint settings-hint--success">{success}</p>}
      <div className="settings-actions-row">
        <button
          type="button"
          className="btn-primary"
          onClick={handleBackup}
          disabled={busy !== null}
        >
          {busy === "backup"
            ? t("settings.backup.backupSaving")
            : t("settings.backup.backupButton")}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleRestorePick}
          disabled={busy !== null}
        >
          {t("settings.backup.restoreButton")}
        </button>
        <input
          ref={restoreInputRef}
          type="file"
          accept=".zip,application/zip"
          style={{ display: "none" }}
          onChange={onRestoreFileChange}
        />
      </div>
      {pendingRestoreFile && (
        <div className="danger-confirm">
          <h4>{t("settings.backup.restoreConfirmTitle")}</h4>
          <p>{t("settings.backup.restoreConfirmText")}</p>
          <p className="settings-hint">
            <code>{pendingRestoreFile.name}</code>
          </p>
          <div className="danger-confirm-actions">
            <button
              type="button"
              className="btn-danger"
              onClick={confirmRestore}
              disabled={busy !== null}
            >
              {busy === "restore"
                ? t("settings.backup.restoreRestoring")
                : t("settings.backup.restoreConfirmYes")}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setPendingRestoreFile(null)}
              disabled={busy !== null}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/// Display-only in the web build: the data directory is fixed for the server
/// process (Docker volume via FINANCES_DATA_DIR, or the per-user default) and
/// cannot be switched from the UI.
function DataDirSection() {
  const t = useT();
  const [info, setInfo] = useState<DataDirInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    dataDirInfo()
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info) {
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">{t("settings.dataDir.title")}</h3>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  const sourceLabel =
    info.source === "env"
      ? t("settings.dataDir.sourceEnv")
      : t("settings.dataDir.sourceDefault");

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t("settings.dataDir.title")}</h3>
      {error && <div className="error">{error}</div>}
      <dl className="settings-data-dir-info">
        <dt>{t("settings.dataDir.currentLabel")}</dt>
        <dd>
          <code>{info.path}</code> <span className="settings-hint">({sourceLabel})</span>
        </dd>
      </dl>
      {info.envOverride && (
        <p className="settings-hint">{t("settings.dataDir.envHint")}</p>
      )}
    </div>
  );
}
