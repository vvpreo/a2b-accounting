#!/usr/bin/env node
// Environment badging of the app icon (see the "Environment badging" rule):
// derives public/favicon.svg from the production source src/assets/app-icon.svg.
//   APP_ENV=prod (default) — exact copy, no marker;
//   APP_ENV=dev | test | uat — a thick coloured frame drawn inside the canvas,
//   with the artwork scaled into the inner area (never recoloured or cropped).
// Runs before every `vite` dev/build (see package.json). The generated file is
// a build artefact and is git-ignored.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FRAME_COLORS = {
  dev: "#E53935",
  test: "#1E88E5",
  uat: "#43A047",
};

/** Frame thickness as a share of the icon side. 12.5% keeps it at 2px on a
 *  16×16 favicon (the minimum) and 4px at 32×32. */
const FRAME_SHARE = 0.125;

/** Return the icon for `env`: the source untouched for prod, a framed
 *  wrapper otherwise. Throws on an unknown stand — guessing would either
 *  mark prod or leave a non-prod stand unmarked. */
export function badgeSvg(source, env) {
  if (env === "prod") return source;
  const color = FRAME_COLORS[env];
  if (!color) {
    throw new Error(
      `Unknown APP_ENV "${env}" (expected prod, ${Object.keys(FRAME_COLORS).join(", ")})`,
    );
  }
  const svg = source.replace(/<\?xml[^>]*>\s*/, "").trim();
  const open = svg.match(/^<svg\b[^>]*>/);
  if (!open) throw new Error("app icon is not an <svg> document");
  // Re-position the original <svg> as a nested viewport inside the frame.
  const side = 100;
  const t = side * FRAME_SHARE;
  const inner = open[0]
    .replace(/\s(width|height|x|y)="[^"]*"/g, "")
    .replace(/^<svg/, `<svg x="${t}" y="${t}" width="${side - 2 * t}" height="${side - 2 * t}"`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="32" height="32">`,
    `<rect x="${t / 2}" y="${t / 2}" width="${side - t}" height="${side - t}" fill="none" stroke="${color}" stroke-width="${t}"/>`,
    inner + svg.slice(open[0].length),
    `</svg>`,
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const env = (process.env.APP_ENV || "prod").toLowerCase();
  const source = readFileSync(join(root, "src/assets/app-icon.svg"), "utf8");
  writeFileSync(join(root, "public/favicon.svg"), badgeSvg(source, env));
  console.log(`[badge-icons] APP_ENV=${env} -> public/favicon.svg`);
}
