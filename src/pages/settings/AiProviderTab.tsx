import { useEffect, useState } from "react";

import {
  AiProviderConfig,
  aiTestConnection,
  loadAiConfig,
  saveAiConfig,
} from "../../lib/api";
import {
  AI_PROVIDER_PRESETS,
  defaultAiConfig,
  findAiPreset,
} from "../../lib/ai-presets";
import { useT } from "../../i18n";

export function AiProviderTab() {
  const t = useT();
  const [config, setConfig] = useState<AiProviderConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: boolean; message: string } | null
  >(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadAiConfig().then((c) => {
      if (!cancelled) setConfig(c ?? defaultAiConfig());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!config) {
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">{t("settings.ai.title")}</h3>
      </div>
    );
  }

  const preset = findAiPreset(config.presetId);

  function update(patch: Partial<AiProviderConfig>) {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaved(false);
    setTestResult(null);
  }

  function onPresetChange(presetId: string) {
    const p = findAiPreset(presetId);
    if (!p) {
      update({ presetId });
      return;
    }
    // Prefill base URL and model from the preset; the fields stay editable.
    update({
      presetId,
      baseUrl: p.baseUrl,
      model: p.defaultModel ?? config?.model ?? "",
    });
  }

  async function onSave() {
    if (!config) return;
    await saveAiConfig(config);
    setSaved(true);
  }

  async function onTest() {
    if (!config) return;
    setTesting(true);
    setTestResult(null);
    try {
      // Persist first so the backend reads the current values.
      await saveAiConfig(config);
      setSaved(true);
      const message = await aiTestConnection();
      setTestResult({ ok: true, message });
    } catch (e) {
      setTestResult({ ok: false, message: String(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t("settings.ai.title")}</h3>
      <p className="settings-hint">{t("settings.ai.hint")}</p>

      <div className="settings-row">
        <label htmlFor="ai-preset">{t("settings.ai.presetLabel")}</label>
        <select
          id="ai-preset"
          value={config.presetId}
          onChange={(e) => onPresetChange(e.target.value)}
        >
          {AI_PROVIDER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-row">
        <label htmlFor="ai-base-url">{t("settings.ai.baseUrlLabel")}</label>
        <input
          id="ai-base-url"
          type="text"
          value={config.baseUrl}
          placeholder="https://openrouter.ai/api/v1"
          onChange={(e) => update({ baseUrl: e.target.value })}
        />
      </div>

      <div className="settings-row">
        <label htmlFor="ai-model">{t("settings.ai.modelLabel")}</label>
        <input
          id="ai-model"
          type="text"
          list="ai-model-options"
          value={config.model}
          placeholder="openai/gpt-4o-mini"
          onChange={(e) => update({ model: e.target.value })}
        />
        {preset?.models && (
          <datalist id="ai-model-options">
            {preset.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        )}
      </div>

      <div className="settings-row">
        <label htmlFor="ai-api-key">{t("settings.ai.apiKeyLabel")}</label>
        <input
          id="ai-api-key"
          type="password"
          value={config.apiKey}
          placeholder="env:OPENROUTER_API_KEY"
          onChange={(e) => update({ apiKey: e.target.value })}
        />
      </div>
      <p className="settings-hint">{t("settings.ai.apiKeyHint")}</p>

      <div className="settings-row">
        <label htmlFor="ai-temperature">
          {t("settings.ai.temperatureLabel")}
        </label>
        <input
          id="ai-temperature"
          type="number"
          step="0.1"
          min="0"
          max="2"
          value={config.temperature ?? 0}
          onChange={(e) =>
            update({ temperature: Number(e.target.value) || 0 })
          }
        />
      </div>

      <div className="settings-actions-row">
        <button type="button" className="btn-primary" onClick={onSave}>
          {t("settings.ai.saveButton")}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={onTest}
          disabled={testing}
        >
          {testing ? t("settings.ai.testing") : t("settings.ai.testButton")}
        </button>
        {saved && (
          <span className="settings-hint settings-hint--success">
            {t("settings.ai.saved")}
          </span>
        )}
      </div>

      {testResult &&
        (testResult.ok ? (
          <p className="settings-hint settings-hint--success">
            {t("settings.ai.testSuccess", { message: testResult.message })}
          </p>
        ) : (
          <div className="error">
            {t("settings.ai.testError", { message: testResult.message })}
          </div>
        ))}
    </div>
  );
}
