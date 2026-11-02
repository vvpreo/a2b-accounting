import type { AiConnection, AiProtocol } from "./api";

/** A template for a new LLM connection. The user creates any number of
 *  connections from these (e.g. a "Custom" one pointing at an Ollama on
 *  their own box); every field stays editable. */
export interface AiProviderPreset {
  id: string;
  name: string;
  protocol: AiProtocol;
  /** Prefilled base URL (empty for Custom). */
  baseUrl: string;
  /** Suggested default model id; free-text, the field stays editable. */
  defaultModel?: string;
  /** Whether the provider needs an API key. Local servers don't. */
  requiresApiKey: boolean;
  /** A few suggested model ids surfaced via a <datalist> for convenience. */
  models?: string[];
  /** Some reasoning models reject a temperature; null = don't send one. */
  temperature: number | null;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5-mini",
    requiresApiKey: true,
    models: ["gpt-5-mini", "gpt-5-nano", "gpt-5"],
    temperature: null,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-haiku-5-5",
    requiresApiKey: true,
    models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
    temperature: 0,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "qwen/qwen3-30b-a3b",
    requiresApiKey: true,
    models: ["qwen/qwen3-30b-a3b", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "mistralai/mistral-small-3.2-24b-instruct"],
    temperature: 0,
  },
  {
    id: "custom",
    name: "Custom",
    protocol: "openai",
    baseUrl: "",
    requiresApiKey: false,
    temperature: 0,
  },
];

export function findAiPreset(id: string): AiProviderPreset | undefined {
  return AI_PROVIDER_PRESETS.find((p) => p.id === id);
}

/** A new, unsaved connection prefilled from a preset. */
export function newConnection(preset: AiProviderPreset): AiConnection {
  return {
    id: 0,
    name: preset.name,
    preset: preset.id,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    model: preset.defaultModel ?? "",
    apiKey: "",
    temperature: preset.temperature,
  };
}
