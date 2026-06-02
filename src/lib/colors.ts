// 12 base hues evenly spaced around the wheel, fixed S=70% / L=55%.
// These are the swatches a user picks from for a top-level category.
export const ROOT_PALETTE: string[] = [
  "#e05757", // 0   red
  "#e08157", // 30  orange
  "#e0b357", // 60  yellow
  "#a8e057", // 90  yellow-green
  "#57e068", // 120 green
  "#57e0b3", // 150 teal
  "#57c8e0", // 180 cyan
  "#5793e0", // 210 blue
  "#5763e0", // 240 indigo
  "#9357e0", // 270 violet
  "#cf57e0", // 300 magenta
  "#e057a3", // 330 pink
];

export interface Hsl {
  h: number; // 0..360
  s: number; // 0..100
  l: number; // 0..100
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function hexToHsl(hex: string): Hsl {
  const m = hex.replace("#", "").trim();
  const r = parseInt(m.substring(0, 2), 16) / 255;
  const g = parseInt(m.substring(2, 4), 16) / 255;
  const b = parseInt(m.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
        break;
      case g:
        h = ((b - r) / delta + 2) * 60;
        break;
      case b:
        h = ((r - g) / delta + 4) * 60;
        break;
    }
  }

  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const sN = clamp(s, 0, 100) / 100;
  const lN = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hh = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) { r = c; g = x; }
  else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; }
  else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = lN - c / 2;
  const to = (v: number) =>
    Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

// Generate evenly-distributed shades of the parent color for a given depth.
// Each shade keeps the parent's hue, tweaks saturation slightly, and shifts
// lightness across a band that lives above the parent's L for nested levels.
export function shadesOf(parentHex: string, depth: number, count = 7): string[] {
  const { h, s } = hexToHsl(parentHex);
  // Anchor lightness band based on depth so deeper levels read as lighter.
  const anchorL = clamp(55 + depth * 10, 35, 85);
  const span = 35; // total L spread of the swatch row
  const sAdjusted = clamp(s - 5, 25, 80);
  const start = clamp(anchorL - span / 2, 25, 90);
  const step = span / (count - 1);
  const result: string[] = [];
  for (let i = 0; i < count; i += 1) {
    result.push(hslToHex({ h, s: sAdjusted, l: clamp(start + step * i, 20, 92) }));
  }
  return result;
}

// Default suggested color for a new child category at a given depth.
export function deriveChildColor(parentHex: string, depth: number): string {
  const { h, s } = hexToHsl(parentHex);
  const targetL = clamp(55 + depth * 10, 35, 80);
  const sAdjusted = clamp(s - 5, 25, 80);
  return hslToHex({ h, s: sAdjusted, l: targetL });
}

// Relative luminance (sRGB, WCAG) of a hex color, 0 (black) .. 1 (white).
function relativeLuminance(hex: string): number {
  const m = hex.replace("#", "").trim();
  const full =
    m.length === 3
      ? m.split("").map((c) => c + c).join("")
      : m.padEnd(6, "0").substring(0, 6);
  const channel = (i: number) => {
    const v = parseInt(full.substring(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * Pick a legible text color (near-black or white) to render on top of an
 * arbitrary background color. Category colors range from saturated mids to very
 * light tints (deep child categories), so white text is unreadable on the light
 * ones — choose by the background's luminance instead of always using white.
 */
export function readableTextColor(backgroundHex: string): string {
  return relativeLuminance(backgroundHex) > 0.55 ? "#18181b" : "#ffffff";
}

// Pick the first palette color not already used by existing root categories.
// Falls back to the first palette color if all are taken.
export function nextRootColor(usedColors: string[]): string {
  const used = new Set(usedColors.map((c) => c.toLowerCase()));
  const free = ROOT_PALETTE.find((c) => !used.has(c.toLowerCase()));
  return free ?? ROOT_PALETTE[0];
}
