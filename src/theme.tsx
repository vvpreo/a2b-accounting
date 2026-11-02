import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { setSetting } from "./lib/api";

/**
 * Theme handling. The user picks one of three *modes*; "system" follows the OS
 * preference live via `matchMedia`. Whatever the mode resolves to, we write a
 * `data-theme="light|dark"` attribute on <html>, which the token blocks at the
 * top of `App.css` switch on. The chosen mode is persisted in `app_settings`
 * under the `theme` key.
 */
export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const SETTING_KEY_THEME = "theme";
export const DEFAULT_THEME_MODE: ThemeMode = "system";

export function isValidThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** Resolve a mode to a concrete light/dark value. */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") return prefersDark() ? "dark" : "light";
  return mode;
}

/** Apply the resolved theme to the document root. Safe to call before render
 *  (from the bootstrap) to avoid a flash of the wrong theme. */
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolveTheme(mode));
}

interface ThemeContextValue {
  /** The user's choice (light / dark / system). */
  mode: ThemeMode;
  /** The concrete theme currently in effect. */
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  initialMode: ThemeMode;
  children: ReactNode;
}

export function ThemeProvider({ initialMode, children }: ThemeProviderProps) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode);
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(initialMode),
  );

  // Reflect the mode onto <html> and keep the resolved value in sync. When the
  // mode is "system", also subscribe to OS preference changes so the app
  // follows the system toggle without a restart.
  useEffect(() => {
    const update = () => {
      const next = resolveTheme(mode);
      setResolved(next);
      document.documentElement.setAttribute("data-theme", next);
    };
    update();

    if (mode !== "system" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [mode]);

  const setMode = useCallback(async (next: ThemeMode) => {
    setModeState(next);
    try {
      await setSetting(SETTING_KEY_THEME, next);
    } catch (e) {
      console.error("[theme] failed to persist theme:", e);
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
