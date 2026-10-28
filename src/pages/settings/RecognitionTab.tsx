import { useEffect, useState } from "react";

import {
  RecognitionConfig,
  loadRecognitionConfig,
  recognitionTestConnection,
  saveRecognitionConfig,
} from "../../lib/api";
import { useT } from "../../i18n";

/** Vision-capable endpoints the user is likely to point recognition at; all
 *  fields stay editable. */
const PRESETS = [
  {
    id: "ollama",
    name: "Ollama (local)",
    baseUrl: "http://host.docker.internal:11434/v1",
    apiKey: "",
    models: ["qwen2.5vl:7b", "qwen2.5vl:3b", "llama3.2-vision:11b"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "env:OPENROUTER_API_KEY",
    models: ["qwen/qwen2.5-vl-72b-instruct", "qwen/qwen2.5-vl-32b-instruct", "openai/gpt-4o-mini", "google/gemini-2.5-flash"],
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "env:OPENAI_API_KEY",
    models: ["gpt-4o-mini", "gpt-4o"],
  },
  { id: "custom", name: "Custom", baseUrl: "", apiKey: "", models: [] as string[] },
];

/** Settings → Recognition: local PaddleOCR (default) or a vision LLM. */
export function RecognitionTab() {
  const t = useT();
  const [config, setConfig] = useState<RecognitionConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadRecognitionConfig().then((c) => !cancelled && setConfig(c));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!config) {
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">{t("settings.recognition.title")}</h3>
      </div>
    );
  }

  const preset = PRESETS.find((p) => p.id === config.presetId);
  const llm = config.engine === "llm";

  function update(patch: Partial<RecognitionConfig>) {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaved(false);
    setTestResult(null);
  }

  function onPresetChange(presetId: string) {
    const p = PRESETS.find((x) => x.id === presetId);
    if (!p || p.id === "custom") {
      update({ presetId });
      return;
    }
    update({ presetId, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.models[0] ?? "" });
  }

  async function onSave() {
    if (!config) return;
    await saveRecognitionConfig(config);
    setSaved(true);
  }

  async function onTest() {
    if (!config) return;
    setTesting(true);
    setTestResult(null);
    try {
      await saveRecognitionConfig(config);
      setSaved(true);
      setTestResult({ ok: true, message: await recognitionTestConnection() });
    } catch (e) {
      setTestResult({ ok: false, message: String(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t("settings.recognition.title")}</h3>
      <p className="settings-hint">{t("settings.recognition.hint")}</p>

      <div className="settings-row">
        <label htmlFor="rec-engine">{t("settings.recognition.engineLabel")}</label>
        <select
          id="rec-engine"
          value={config.engine}
          onChange={(e) => update({ engine: e.target.value as RecognitionConfig["engine"] })}
        >
          <option value="local">{t("settings.recognition.engineLocal")}</option>
          <option value="llm">{t("settings.recognition.engineLlm")}</option>
        </select>
      </div>

      {llm && (
        <>
          <div className="danger-confirm">
            <p>{t("settings.recognition.llmWarning")}</p>
          </div>

          <div className="settings-row">
            <label htmlFor="rec-preset">{t("settings.ai.presetLabel")}</label>
            <select
              id="rec-preset"
              value={config.presetId ?? "custom"}
              onChange={(e) => onPresetChange(e.target.value)}
            >
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="settings-row">
            <label htmlFor="rec-base-url">{t("settings.ai.baseUrlLabel")}</label>
            <input
              id="rec-base-url"
              type="text"
              value={config.baseUrl}
              placeholder="http://host.docker.internal:11434/v1"
              onChange={(e) => update({ baseUrl: e.target.value })}
            />
          </div>

          <div className="settings-row">
            <label htmlFor="rec-model">{t("settings.ai.modelLabel")}</label>
            <input
              id="rec-model"
              type="text"
              list="rec-model-options"
              value={config.model}
              placeholder="qwen2.5vl:7b"
              onChange={(e) => update({ model: e.target.value })}
            />
            {preset && preset.models.length > 0 && (
              <datalist id="rec-model-options">
                {preset.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
          </div>
          <p className="settings-hint">{t("settings.recognition.modelHint")}</p>

          <div className="settings-row">
            <label htmlFor="rec-api-key">{t("settings.ai.apiKeyLabel")}</label>
            <input
              id="rec-api-key"
              type="password"
              value={config.apiKey}
              placeholder="env:OPENROUTER_API_KEY"
              onChange={(e) => update({ apiKey: e.target.value })}
            />
          </div>
          <p className="settings-hint">{t("settings.ai.apiKeyHint")}</p>

          <div className="settings-row">
            <label htmlFor="rec-temperature">{t("settings.ai.temperatureLabel")}</label>
            <input
              id="rec-temperature"
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={config.temperature ?? 0}
              onChange={(e) => update({ temperature: Number(e.target.value) || 0 })}
            />
          </div>
        </>
      )}

      <div className="settings-actions-row">
        <button type="button" className="btn-primary" onClick={onSave}>
          {t("settings.ai.saveButton")}
        </button>
        {llm && (
          <button type="button" className="btn-secondary" onClick={onTest} disabled={testing}>
            {testing ? t("settings.ai.testing") : t("settings.ai.testButton")}
          </button>
        )}
        {saved && <span className="settings-hint settings-hint--success">{t("settings.ai.saved")}</span>}
      </div>
      <p className="settings-hint">{t("settings.recognition.rerunHint")}</p>

      {testResult &&
        (testResult.ok ? (
          <p className="settings-hint settings-hint--success">
            {t("settings.ai.testSuccess", { message: testResult.message })}
          </p>
        ) : (
          <div className="error">{t("settings.ai.testError", { message: testResult.message })}</div>
        ))}
    </div>
  );
}
