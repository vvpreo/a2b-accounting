import { describe, expect, it } from "vitest";

import { badgeSvg, FRAME_COLORS } from "./badge-icons.mjs";

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="31.88" height="32" viewBox="0 0 256 257"><path fill="#41D1FF" d="M0 0h1"/></svg>';

describe("badgeSvg", () => {
  it("leaves the production icon untouched", () => {
    expect(badgeSvg(ICON, "prod")).toBe(ICON);
  });

  it.each(Object.entries(FRAME_COLORS))("frames the %s icon in %s", (env, color) => {
    const out = badgeSvg(ICON, env);
    expect(out).toContain(`stroke="${color}"`);
    // Artwork is kept verbatim (no recolouring), only re-positioned.
    expect(out).toContain('<path fill="#41D1FF" d="M0 0h1"/>');
    expect(out).toContain('viewBox="0 0 256 257"');
    expect(out).not.toContain('width="31.88"');
  });

  it("refuses an unknown stand instead of guessing", () => {
    expect(() => badgeSvg(ICON, "staging")).toThrow(/APP_ENV/);
  });
});
