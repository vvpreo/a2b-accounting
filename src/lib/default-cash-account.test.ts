import { describe, expect, it } from "vitest";

import { Account } from "./api";
import { currenciesWithSeveralCashAccounts, preselectCashAccount } from "./default-cash-account";

const account = (id: number, currency: string, kind: "cash" | "bank" = "cash") =>
  ({ id, currency, kind, name: `A${id}` }) as Account;

describe("preselectCashAccount", () => {
  const accounts = [account(1, "USD"), account(2, "THB"), account(3, "THB")];

  it("takes the account assigned to the currency", () => {
    expect(preselectCashAccount(accounts, "THB", "3")?.id).toBe(3);
  });

  it("falls back to the currency's first account without a valid choice", () => {
    expect(preselectCashAccount(accounts, "THB", null)?.id).toBe(2);
    expect(preselectCashAccount(accounts, "THB", "")?.id).toBe(2);
    expect(preselectCashAccount(accounts, "THB", "99")?.id).toBe(2);
    // The default of another currency does not count.
    expect(preselectCashAccount(accounts, "THB", "1")?.id).toBe(2);
  });

  it("offers another currency when this one has no cash account", () => {
    expect(preselectCashAccount(accounts, "EUR", null)?.id).toBe(1);
    expect(preselectCashAccount([], "EUR", null)).toBeNull();
  });
});

describe("currenciesWithSeveralCashAccounts", () => {
  it("lists only cash accounts of currencies with more than one", () => {
    const listed = currenciesWithSeveralCashAccounts([
      account(1, "USD"),
      account(2, "USD", "bank"),
      account(3, "THB"),
      account(4, "THB"),
    ]);
    expect(listed.map(([c, list]) => [c, list.map((a) => a.id)])).toEqual([["THB", [3, 4]]]);
  });
});
