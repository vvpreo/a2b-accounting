import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import {
  DEFAULT_LOCALE,
  I18nProvider,
  LocaleCode,
  SETTING_KEY_LOCALE,
  detectSystemLocale,
  isValidLocale,
} from "./i18n";
import {
  DEFAULT_THEME_MODE,
  SETTING_KEY_THEME,
  ThemeMode,
  ThemeProvider,
  applyTheme,
  isValidThemeMode,
} from "./theme";
import { getSetting } from "./lib/api";

async function loadInitialLocale(): Promise<LocaleCode> {
  try {
    const stored = await getSetting(SETTING_KEY_LOCALE);
    if (isValidLocale(stored)) return stored;
  } catch (e) {
    console.error("[i18n] failed to read stored locale:", e);
  }
  try {
    return detectSystemLocale();
  } catch {
    return DEFAULT_LOCALE;
  }
}

async function loadInitialThemeMode(): Promise<ThemeMode> {
  try {
    const stored = await getSetting(SETTING_KEY_THEME);
    if (isValidThemeMode(stored)) return stored;
  } catch (e) {
    console.error("[theme] failed to read stored theme:", e);
  }
  return DEFAULT_THEME_MODE;
}

async function bootstrap() {
  const [locale, themeMode] = await Promise.all([
    loadInitialLocale(),
    loadInitialThemeMode(),
  ]);
  // Apply before first paint so there is no flash of the wrong theme.
  applyTheme(themeMode);
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ThemeProvider initialMode={themeMode}>
        <I18nProvider initialLocale={locale}>
          <App />
        </I18nProvider>
      </ThemeProvider>
    </React.StrictMode>,
  );
}

bootstrap();
