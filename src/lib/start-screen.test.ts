import { describe, expect, it } from "vitest";

import { needsTransactionCheck, parseStartScreen, resolveStartTab } from "./start-screen";

describe("parseStartScreen", () => {
  it("accepts known values and report ids", () => {
    expect(parseStartScreen("accounts")).toBe("accounts");
    expect(parseStartScreen("transactions")).toBe("transactions");
    expect(parseStartScreen("report:7")).toBe("report:7");
  });

  it("falls back to auto for missing or unknown values", () => {
    expect(parseStartScreen(null)).toBe("auto");
    expect(parseStartScreen("settings")).toBe("auto");
    expect(parseStartScreen("report:x")).toBe("auto");
  });
});

describe("resolveStartTab", () => {
  it("opens the chosen static screen regardless of data", () => {
    expect(resolveStartTab("accounts", [], true)).toBe("accounts");
    expect(resolveStartTab("transactions", [], false)).toBe("transactions");
  });

  it("opens an existing report", () => {
    expect(resolveStartTab("report:3", [1, 3], false)).toEqual({ kind: "report", id: 3 });
    expect(needsTransactionCheck("report:3", [1, 3])).toBe(false);
  });

  it("falls back to auto when the report was deleted", () => {
    expect(needsTransactionCheck("report:9", [1])).toBe(true);
    expect(resolveStartTab("report:9", [1], true)).toBe("transactions");
    expect(resolveStartTab("report:9", [1], false)).toBe("accounts");
  });

  it("auto picks transactions only when some exist", () => {
    expect(resolveStartTab("auto", [], true)).toBe("transactions");
    expect(resolveStartTab("auto", [], false)).toBe("accounts");
  });
});
