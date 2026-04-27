import {
  ReactNode,
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import en from "./locales/en.json";
import ru from "./locales/ru.json";
import { setSetting } from "../lib/api";

export const LANGUAGES = [
  { code: "en", name: "English", messages: en },
  { code: "ru", name: "Русский", messages: ru },
] as const;

export type LocaleCode = (typeof LANGUAGES)[number]["code"];

export const DEFAULT_LOCALE: LocaleCode = "en";
export const SETTING_KEY_LOCALE = "locale";

export function isValidLocale(value: unknown): value is LocaleCode {
  return (
    typeof value === "string" &&
    LANGUAGES.some((l) => l.code === value)
  );
}

export function detectSystemLocale(): LocaleCode {
  const lang = (
    typeof navigator !== "undefined" ? navigator.language : ""
  ).toLowerCase();
  if (lang.startsWith("ru")) return "ru";
  return "en";
}

type Messages = Record<string, unknown>;
type TParams = Record<string, string | number>;

function lookup(messages: Messages, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node && typeof node === "object" && part in (node as Messages)) {
      return (node as Messages)[part];
    }
    return undefined;
  }, messages);
}

function interpolate(template: string, params: TParams | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  );
}

function selectPlural(
  forms: Record<string, string>,
  category: string,
): string | undefined {
  return forms[category] ?? forms.other;
}

interface I18nContextValue {
  locale: LocaleCode;
  setLocale: (code: LocaleCode) => Promise<void>;
  t: (key: string, params?: TParams) => string;
  tPlural: (key: string, count: number, params?: TParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps {
  initialLocale: LocaleCode;
  children: ReactNode;
}

export function I18nProvider({ initialLocale, children }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<LocaleCode>(initialLocale);

  const messages = useMemo(() => {
    const lang = LANGUAGES.find((l) => l.code === locale);
    return (lang ?? LANGUAGES[0]).messages as Messages;
  }, [locale]);

  const t = useCallback(
    (key: string, params?: TParams): string => {
      const node = lookup(messages, key);
      if (typeof node === "string") return interpolate(node, params);
      if (import.meta.env.DEV) {
        console.warn(`[i18n] missing or non-string key "${key}" for ${locale}`);
      }
      return key;
    },
    [messages, locale],
  );

  const tPlural = useCallback(
    (key: string, count: number, params?: TParams): string => {
      const node = lookup(messages, key);
      if (node && typeof node === "object" && !Array.isArray(node)) {
        const rules = new Intl.PluralRules(locale);
        const category = rules.select(count);
        const template = selectPlural(node as Record<string, string>, category);
        if (typeof template === "string") {
          return interpolate(template, { count, ...(params ?? {}) });
        }
      }
      if (import.meta.env.DEV) {
        console.warn(`[i18n] missing plural key "${key}" for ${locale}`);
      }
      return key;
    },
    [messages, locale],
  );

  const setLocale = useCallback(async (code: LocaleCode) => {
    setLocaleState(code);
    try {
      await setSetting(SETTING_KEY_LOCALE, code);
    } catch (e) {
      console.error("[i18n] failed to persist locale:", e);
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t, tPlural }),
    [locale, setLocale, t, tPlural],
  );

  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

export function useT() {
  return useI18n().t;
}

export function useTPlural() {
  return useI18n().tPlural;
}
