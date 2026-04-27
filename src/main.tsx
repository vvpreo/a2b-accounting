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

async function bootstrap() {
  const locale = await loadInitialLocale();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <I18nProvider initialLocale={locale}>
        <App />
      </I18nProvider>
    </React.StrictMode>,
  );
}

bootstrap();
