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
    defaultModel: "openai/gpt-4o-mini",
    requiresApiKey: true,
    models: [
      "openai/gpt-4o-mini",
      "openai/gpt-4o",
      "anthropic/claude-3.5-sonnet",
      "google/gemini-2.0-flash-001",
      "meta-llama/llama-3.1-70b-instruct",
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
    model: "openai/gpt-4o-mini",
    apiKey: "env:OPENROUTER_API_KEY",
    temperature: 0,
  };
}
