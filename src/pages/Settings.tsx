import { useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import {
  backupToZip,
  clearAllData,
  DataDirInfo,
  dataDirInfo,
  resetDataDir,
  restartApp,
  restoreFromZip,
  seedDemoData,
  setDataDir,
} from "../lib/api";
import { LANGUAGES, LocaleCode, useI18n, useT } from "../i18n";
import { CurrenciesTab } from "./settings/CurrenciesTab";

type SettingsTab = "general" | "currencies";

export function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
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

          <BackupSection />
          <DataDirSection />
          <DemoDataSection />
          <DangerZoneSection />
        </>
      )}

      {tab === "currencies" && <CurrenciesTab />}
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
  const [pendingRestorePath, setPendingRestorePath] = useState<string | null>(
    null,
  );

  async function handleBackup() {
    setError(null);
    setSuccess(null);
    // ISO-ish date (no time): matches the default-name placeholder
    // and stays sortable as a plain string.
    const today = new Date().toISOString().slice(0, 10);
    const defaultName = t("settings.backup.backupDefaultName", { date: today });
    let chosen: string | null;
    try {
      chosen = await saveDialog({
        defaultPath: defaultName,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
    } catch (e) {
      setError(t("settings.backup.backupError", { message: String(e) }));
      return;
    }
    if (!chosen) return;
    setBusy("backup");
    try {
      await backupToZip(chosen);
      setSuccess(t("settings.backup.backupSuccess", { path: chosen }));
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

  async function handleRestorePick() {
    setError(null);
    setSuccess(null);
    let chosen: string | string[] | null;
    try {
      chosen = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
    } catch (e) {
      setError(t("settings.backup.restoreError", { message: String(e) }));
      return;
    }
    if (!chosen || Array.isArray(chosen)) return;
    setPendingRestorePath(chosen);
  }

  async function confirmRestore() {
    if (!pendingRestorePath) return;
    setBusy("restore");
    setError(null);
    try {
      await restoreFromZip(pendingRestorePath);
      // Restart so the app reopens the new DB file. The command never
      // returns, but we await for symmetry with the other paths.
      await restartApp();
    } catch (e) {
      setError(
        t("settings.backup.restoreError", {
          message: localizeBackupError(String(e), t, "settings.backup.errorCodes"),
        }),
      );
      setBusy(null);
      setPendingRestorePath(null);
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
      </div>
      {pendingRestorePath && (
        <div className="danger-confirm">
          <h4>{t("settings.backup.restoreConfirmTitle")}</h4>
          <p>{t("settings.backup.restoreConfirmText")}</p>
          <p className="settings-hint">
            <code>{pendingRestorePath}</code>
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
              onClick={() => setPendingRestorePath(null)}
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

function DataDirSection() {
  const t = useT();
  const [info, setInfo] = useState<DataDirInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

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

  async function handlePick() {
    if (!info || info.envOverride) return;
    setError(null);
    let chosen: string | string[] | null;
    try {
      chosen = await openDialog({
        multiple: false,
        directory: true,
        defaultPath: info.path,
      });
    } catch (e) {
      setError(t("settings.dataDir.errorChanging", { message: String(e) }));
      return;
    }
    if (!chosen || Array.isArray(chosen)) return;
    if (chosen === info.path) return;
    setPendingPath(chosen);
  }

  async function confirmSwitch() {
    if (!pendingPath) return;
    setBusy(true);
    setError(null);
    try {
      await setDataDir(pendingPath);
      await restartApp();
    } catch (e) {
      setError(
        t("settings.dataDir.errorChanging", {
          message: localizeBackupError(String(e), t, "settings.dataDir.errorCodes"),
        }),
      );
      setBusy(false);
      setPendingPath(null);
    }
  }

  async function confirmReset() {
    setBusy(true);
    setError(null);
    try {
      await resetDataDir();
      await restartApp();
    } catch (e) {
      setError(
        t("settings.dataDir.errorChanging", {
          message: localizeBackupError(String(e), t, "settings.dataDir.errorCodes"),
        }),
      );
      setBusy(false);
      setConfirmingReset(false);
    }
  }

  if (!info) {
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">{t("settings.dataDir.title")}</h3>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  const sourceLabel = (() => {
    switch (info.source) {
      case "default":
        return t("settings.dataDir.sourceDefault");
      case "pointer":
        return t("settings.dataDir.sourcePointer");
      case "env":
        return t("settings.dataDir.sourceEnv");
    }
  })();

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t("settings.dataDir.title")}</h3>
      <p className="settings-hint">{t("settings.dataDir.hint")}</p>
      {error && <div className="error">{error}</div>}
      <dl className="settings-data-dir-info">
        <dt>{t("settings.dataDir.currentLabel")}</dt>
        <dd>
          <code>{info.path}</code> <span className="settings-hint">({sourceLabel})</span>
        </dd>
        {info.source !== "default" && (
          <>
            <dt>{t("settings.dataDir.defaultLabel")}</dt>
            <dd>
              <code>{info.defaultPath}</code>
            </dd>
          </>
        )}
      </dl>
      {info.envOverride && (
        <p className="settings-hint">{t("settings.dataDir.envHint")}</p>
      )}
      {!info.envOverride && (
        <div className="settings-actions-row">
          <button
            type="button"
            className="btn-primary"
            onClick={handlePick}
            disabled={busy}
          >
            {t("settings.dataDir.changeButton")}
          </button>
          {info.source === "pointer" && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setConfirmingReset(true)}
              disabled={busy}
            >
              {t("settings.dataDir.resetButton")}
            </button>
          )}
        </div>
      )}
      {pendingPath && (
        <div className="danger-confirm">
          <h4>{t("settings.dataDir.confirmTitle")}</h4>
          <p>{t("settings.dataDir.confirmText", { path: pendingPath })}</p>
          <div className="danger-confirm-actions">
            <button
              type="button"
              className="btn-danger"
              onClick={confirmSwitch}
              disabled={busy}
            >
              {t("settings.dataDir.confirmYes")}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setPendingPath(null)}
              disabled={busy}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
      {confirmingReset && (
        <div className="danger-confirm">
          <h4>{t("settings.dataDir.resetConfirmTitle")}</h4>
          <p>
            {t("settings.dataDir.resetConfirmText", { path: info.defaultPath })}
          </p>
          <div className="danger-confirm-actions">
            <button
              type="button"
              className="btn-danger"
              onClick={confirmReset}
              disabled={busy}
            >
              {t("settings.dataDir.confirmYes")}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setConfirmingReset(false)}
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
