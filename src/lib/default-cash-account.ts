import { Account } from "./api";

/**
 * The cash account withdrawals in a currency go to when the currency has
 * several, persisted in `app_settings` per currency. An empty value, or an
 * account that is gone, means no choice: the app picks by itself.
 */
export function defaultCashAccountKey(currency: string): string {
  return `default_cash_account.${currency}`;
}

/** The cash account to preselect for a withdrawal in `currency`. */
export function preselectCashAccount(
  cashAccounts: Account[],
  currency: string,
  storedDefault: string | null,
): Account | null {
  const sameCurrency = cashAccounts.filter((a) => a.currency === currency);
  return (
    sameCurrency.find((a) => String(a.id) === storedDefault) ?? sameCurrency[0] ?? cashAccounts[0] ?? null
  );
}

/** Currencies that have a choice to make, with their cash accounts. */
export function currenciesWithSeveralCashAccounts(accounts: Account[]): [string, Account[]][] {
  const byCurrency = new Map<string, Account[]>();
  for (const a of accounts) {
    if (a.kind !== "cash") continue;
    byCurrency.set(a.currency, [...(byCurrency.get(a.currency) ?? []), a]);
  }
  return [...byCurrency.entries()]
    .filter(([, list]) => list.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));
}
