import type { Tab } from "../components/Tabs";

/**
 * The screen the app opens on, persisted in `app_settings` under
 * `start_screen`. "auto" keeps the original behaviour: Transactions when any
 * exist, otherwise Accounts. A report is stored as `report:<id>`.
 */
export type StartScreen = "auto" | "accounts" | "transactions" | `report:${number}`;

export const SETTING_KEY_START_SCREEN = "start_screen";
export const DEFAULT_START_SCREEN: StartScreen = "auto";

export function parseStartScreen(raw: string | null | undefined): StartScreen {
  if (raw === "accounts" || raw === "transactions" || raw === "auto") return raw;
  const m = /^report:(\d+)$/.exec(raw ?? "");
  return m ? `report:${Number(m[1])}` : DEFAULT_START_SCREEN;
}

/** The report id a start-screen value points at, or null. */
export function startScreenReportId(screen: StartScreen): number | null {
  return screen.startsWith("report:") ? Number(screen.slice("report:".length)) : null;
}

/**
 * Resolve the stored choice to a tab. A report that no longer exists falls
 * back to "auto", which needs `hasTransactions` — callers only have to load
 * it when `needsTransactionCheck` says so.
 */
export function resolveStartTab(
  screen: StartScreen,
  reportViewIds: number[],
  hasTransactions: boolean,
): Tab {
  if (screen === "accounts" || screen === "transactions") return screen;
  const reportId = startScreenReportId(screen);
  if (reportId !== null && reportViewIds.includes(reportId)) {
    return { kind: "report", id: reportId };
  }
  return hasTransactions ? "transactions" : "accounts";
}

export function needsTransactionCheck(screen: StartScreen, reportViewIds: number[]): boolean {
  if (screen === "accounts" || screen === "transactions") return false;
  const reportId = startScreenReportId(screen);
  return reportId === null || !reportViewIds.includes(reportId);
}
