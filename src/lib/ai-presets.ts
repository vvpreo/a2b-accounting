import type { AiProviderConfig } from "./api";

export interface AiProviderPreset {
  id: string;
  name: string;
  /** Prefilled OpenAI-compatible base URL (the user can still edit it). */
  baseUrl: string;
  /** Suggested default model id; free-text, the field stays editable. */
  defaultModel?: string;
  /** Whether the provider needs an API key. Local servers don't. */
  requiresApiKey: boolean;
  /** A few suggested model ids surfaced via a <datalist> for convenience. */
  models?: string[];
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "qwen/qwen3-30b-a3b",
    requiresApiKey: true,
    // Open-weight models that can later be self-hosted locally (Ollama/MLX),
    // chosen for tool calling + multilingual (RU/TH) support. Larger sizes
    // first, then the compact fallbacks for low-RAM local runs.
    models: [
      "qwen/qwen3-30b-a3b",
      "qwen/qwen3-14b",
      "qwen/qwen3-8b",
      "mistralai/mistral-small-3.2-24b-instruct",
      "openai/gpt-4o-mini",
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    requiresApiKey: true,
    models: ["gpt-4o-mini", "gpt-4o"],
  },
  {
    id: "custom",
    name: "Custom / Local",
    baseUrl: "",
    requiresApiKey: false,
  },
];

export function findAiPreset(id: string): AiProviderPreset | undefined {
  return AI_PROVIDER_PRESETS.find((p) => p.id === id);
}

/** Default config used when nothing is stored yet. Mirrors the backend seed
 *  (`seed::ensure_ai_provider_config`): OpenRouter with the key read from the
 *  `OPENROUTER_API_KEY` environment variable. */
export function defaultAiConfig(): AiProviderConfig {
  return {
    presetId: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3-30b-a3b",
    apiKey: "env:OPENROUTER_API_KEY",
    temperature: 0,
  };
}
