import { useEffect, useState } from "react";

import {
  AgentSettings,
  AiConnection,
  TokenUsageRow,
  agentTokenUsage,
  aiTestConnection,
  deleteAiConnection,
  exportAgentLog,
  getAgentSettings,
  listAiConnections,
  saveAgentSettings,
  saveAiConnection,
} from "../../lib/api";
import { AI_PROVIDER_PRESETS, findAiPreset, newConnection } from "../../lib/ai-presets";
import { useI18n, useT } from "../../i18n";

type TestResult = { id: number; ok: boolean; message: string };

/// Settings → AI: the user's LLM connections (created from presets), the
/// category agent (which connection, the user's instructions, examples) and
/// what it has spent.
export function AiProviderTab() {
  const t = useT();
  const [connections, setConnections] = useState<AiConnection[] | null>(null);
  const [editing, setEditing] = useState<AiConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [agent, setAgent] = useState<AgentSettings | null>(null);

  async function reload() {
    const [list, settings] = await Promise.all([listAiConnections(), getAgentSettings()]);
    setConnections(list);
    setAgent(settings);
  }

  useEffect(() => {
    reload().catch((e) => setError(String(e)));
  }, []);

  async function onSave() {
    if (!editing) return;
    setError(null);
    try {
      await saveAiConnection(editing);
      setEditing(null);
      await reload();
    } catch (e) {
      const code = String(e);
      setError(code.startsWith("ai.") ? t(`settings.ai.error.${code.slice("ai.".length)}`) : code);
    }
  }

  async function onDelete(c: AiConnection) {
    if (!window.confirm(t("settings.ai.deleteConfirm", { name: c.name }))) return;
    await deleteAiConnection(c.id);
    await reload();
  }

  async function onTest(id: number) {
    setTesting(id);
    setTestResult(null);
    try {
      setTestResult({ id, ok: true, message: await aiTestConnection(id) });
    } catch (e) {
      setTestResult({ id, ok: false, message: String(e) });
    } finally {
      setTesting(null);
    }
  }

  if (!connections || !agent) {
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">{t("settings.ai.title")}</h3>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  return (
    <>
      <div className="settings-section">
        <h3 className="settings-section-title">{t("settings.ai.title")}</h3>
        <p className="settings-hint">{t("settings.ai.hint")}</p>

        {connections.length === 0 ? (
          <p className="hint">{t("settings.ai.empty")}</p>
        ) : (
          <table className="ai-connections">
            <tbody>
              {connections.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.name}</strong>
                    {agent.connectionId === c.id && <span className="ai-agent-badge">{t("settings.ai.usedByAgent")}</span>}
                    <div className="hint">
                      {findAiPreset(c.preset)?.name ?? c.preset} · {c.model} · {c.baseUrl}
                    </div>
                    {testResult?.id === c.id &&
                      (testResult.ok ? (
                        <div className="settings-hint settings-hint--success">
                          {t("settings.ai.testSuccess", { message: testResult.message })}
                        </div>
                      ) : (
                        <div className="error">{t("settings.ai.testError", { message: testResult.message })}</div>
                      ))}
                  </td>
                  <td className="ai-connection-actions">
                    <button type="button" className="btn-secondary" disabled={testing !== null} onClick={() => onTest(c.id)}>
                      {testing === c.id ? t("settings.ai.testing") : t("settings.ai.testButton")}
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => setEditing({ ...c })}>
                      {t("settings.ai.edit")}
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => onDelete(c)}>
                      {t("settings.ai.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {editing ? (
          <ConnectionForm
            value={editing}
            onChange={setEditing}
            onSave={onSave}
            onCancel={() => {
              setEditing(null);
              setError(null);
            }}
          />
        ) : (
          <div className="settings-actions-row">
            <span>{t("settings.ai.addFrom")}</span>
            {AI_PROVIDER_PRESETS.map((p) => (
              <button key={p.id} type="button" className="btn-secondary" onClick={() => setEditing(newConnection(p))}>
                + {p.name}
              </button>
            ))}
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>

      <AgentSection
        connections={connections}
        value={agent}
        onSaved={(s) => setAgent(s)}
      />

      <UsageSection />
    </>
  );
}

function ConnectionForm({
  value,
  onChange,
  onSave,
  onCancel,
}: {
  value: AiConnection;
  onChange: (c: AiConnection) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const preset = findAiPreset(value.preset);
  const update = (patch: Partial<AiConnection>) => onChange({ ...value, ...patch });
  return (
    <div className="ai-connection-form">
      <h4>{value.id ? t("settings.ai.editTitle") : t("settings.ai.newTitle", { preset: preset?.name ?? value.preset })}</h4>
      <div className="settings-row">
        <label htmlFor="ai-name">{t("settings.ai.nameLabel")}</label>
        <input id="ai-name" type="text" value={value.name} onChange={(e) => update({ name: e.target.value })} />
      </div>
      <div className="settings-row">
        <label htmlFor="ai-protocol">{t("settings.ai.protocolLabel")}</label>
        <select
          id="ai-protocol"
          value={value.protocol}
          onChange={(e) => update({ protocol: e.target.value as AiConnection["protocol"] })}
        >
          <option value="openai">{t("settings.ai.protocol.openai")}</option>
          <option value="anthropic">{t("settings.ai.protocol.anthropic")}</option>
        </select>
      </div>
      <div className="settings-row">
        <label htmlFor="ai-base-url">{t("settings.ai.baseUrlLabel")}</label>
        <input
          id="ai-base-url"
          type="text"
          value={value.baseUrl}
          placeholder="http://192.168.1.10:11434/v1"
          onChange={(e) => update({ baseUrl: e.target.value })}
        />
      </div>
      <div className="settings-row">
        <label htmlFor="ai-model">{t("settings.ai.modelLabel")}</label>
        <input
          id="ai-model"
          type="text"
          list="ai-model-options"
          value={value.model}
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
          value={value.apiKey}
          placeholder={preset?.requiresApiKey ? "sk-… / env:API_KEY" : t("settings.ai.apiKeyOptional")}
          onChange={(e) => update({ apiKey: e.target.value })}
        />
      </div>
      <p className="settings-hint">{t("settings.ai.apiKeyHint")}</p>
      <div className="settings-row">
        <label htmlFor="ai-temperature">{t("settings.ai.temperatureLabel")}</label>
        <input
          id="ai-temperature"
          type="number"
          step="0.1"
          min="0"
          max="2"
          placeholder={t("settings.ai.temperatureDefault")}
          value={value.temperature ?? ""}
          onChange={(e) => update({ temperature: e.target.value === "" ? null : Number(e.target.value) })}
        />
      </div>
      <div className="settings-actions-row">
        <button type="button" className="btn-primary" onClick={onSave}>
          {t("settings.ai.saveButton")}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

function AgentSection({
  connections,
  value,
  onSaved,
}: {
  connections: AiConnection[];
  value: AgentSettings;
  onSaved: (s: AgentSettings) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(value), [value]);
  const update = (patch: Partial<AgentSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setSaved(false);
  };
  const connection = connections.find((c) => c.id === draft.connectionId);
  const cloud = connection && findAiPreset(connection.preset)?.requiresApiKey;

  async function onSave() {
    setError(null);
    try {
      await saveAgentSettings(draft);
      onSaved(draft);
      setSaved(true);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t("settings.agent.title")}</h3>
      <p className="settings-hint">{t("settings.agent.hint")}</p>
      <div className="settings-row">
        <label htmlFor="agent-connection">{t("settings.agent.connection")}</label>
        <select
          id="agent-connection"
          value={draft.connectionId ?? ""}
          onChange={(e) => update({ connectionId: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">{t("settings.agent.noConnection")}</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.model}
            </option>
          ))}
        </select>
      </div>
      {cloud && <p className="settings-hint">{t("settings.agent.cloudWarning")}</p>}
      <label className="agent-instructions">
        <span>{t("settings.agent.instructions")}</span>
        <textarea rows={7} value={draft.instructions} onChange={(e) => update({ instructions: e.target.value })} />
      </label>
      <p className="settings-hint">{t("settings.agent.instructionsHint")}</p>
      <div className="settings-row">
        <label htmlFor="agent-per-category">{t("settings.agent.examplesPerCategory")}</label>
        <input
          id="agent-per-category"
          type="number"
          min={0}
          max={10}
          value={draft.examplesPerCategory}
          onChange={(e) => update({ examplesPerCategory: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })}
        />
      </div>
      <div className="settings-row">
        <label htmlFor="agent-min-confidence">{t("settings.agent.minConfidence")}</label>
        <input
          id="agent-min-confidence"
          type="number"
          min={0}
          max={10}
          value={draft.minConfidence}
          onChange={(e) => update({ minConfidence: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })}
        />
      </div>
      <p className="settings-hint">{t("settings.agent.minConfidenceHint")}</p>
      <label className="agent-checkbox">
        <input type="checkbox" checked={draft.autoExamples} onChange={(e) => update({ autoExamples: e.target.checked })} />
        {t("settings.agent.autoExamples")}
      </label>
      <div className="settings-actions-row">
        <button type="button" className="btn-primary" onClick={onSave}>
          {t("settings.ai.saveButton")}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={draft.instructions === draft.defaultInstructions}
          onClick={() => update({ instructions: draft.defaultInstructions })}
        >
          {t("settings.agent.resetInstructions")}
        </button>
        {saved && <span className="settings-hint settings-hint--success">{t("settings.ai.saved")}</span>}
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function UsageSection() {
  const t = useT();
  const { locale } = useI18n();
  const [rows, setRows] = useState<TokenUsageRow[] | null>(null);
  useEffect(() => {
    agentTokenUsage().then(setRows, () => setRows([]));
  }, []);
  const n = (v: number) => v.toLocaleString(locale);

  async function onExport() {
    const log = await exportAgentLog();
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `a2b-agent-log-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t("settings.agent.usageTitle")}</h3>
      {!rows || rows.length === 0 ? (
        <p className="hint">{t("settings.agent.usageEmpty")}</p>
      ) : (
        <table className="ai-usage">
          <thead>
            <tr>
              <th>{t("settings.agent.usageModel")}</th>
              <th className="num">{t("settings.agent.usageCalls")}</th>
              <th className="num">{t("settings.agent.usagePrompt")}</th>
              <th className="num">{t("settings.agent.usageCompletion")}</th>
              <th className="num">{t("settings.agent.usageTotal")}</th>
              <th className="num">{t("settings.agent.usageAvgTime")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.connectionName}|${r.model}`}>
                <td>
                  {r.connectionName} · {r.model}
                </td>
                <td className="num">
                  {n(r.calls)}
                  {r.errors > 0 && <span className="hint"> ({t("settings.agent.usageErrors", { count: r.errors })})</span>}
                </td>
                <td className="num">{n(r.promptTokens)}</td>
                <td className="num">
                  {n(r.completionTokens)}
                  {r.reasoningTokens > 0 && <span className="hint"> ({t("settings.agent.usageReasoning", { count: n(r.reasoningTokens) })})</span>}
                </td>
                <td className="num">{n(r.totalTokens)}</td>
                <td className="num">{(r.durationMs / Math.max(1, r.calls) / 1000).toFixed(1)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="settings-actions-row">
        <button type="button" className="btn-secondary" onClick={onExport}>
          {t("settings.agent.exportLog")}
        </button>
        <span className="settings-hint">{t("settings.agent.exportLogHint")}</span>
      </div>
    </div>
  );
}
