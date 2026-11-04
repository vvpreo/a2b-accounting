import { triggerDownload, WaterfallOrientation } from "./api";
import { WaterfallColumn, WaterfallZone } from "./report-waterfall";

export interface WaterfallImageColumn {
  column: WaterfallColumn;
  label: string;
  /** A second, quieter line: a balance's date, or "the rest". */
  note?: string;
  dotColor?: string;
  value: string;
}

export interface WaterfallImageSpec {
  title: string;
  changeLabel: string;
  change: string;
  currency: string;
  orientation: WaterfallOrientation;
  min: number;
  max: number;
  ticks: { value: number; label: string }[];
  zones: (WaterfallZone & { title: string })[];
  columns: WaterfallImageColumn[];
}

// A picture goes into documents and messages, so it stays light in any theme.
const INK = "#1a1a1a";
const MUTED = "#71717a";
const GRID = "#ececef";
const AXIS = "#a1a1aa";
const COLORS: Record<WaterfallColumn["kind"], string> = {
  opening: "#52606d",
  closing: "#52606d",
  income: "#16977b",
  incomeStep: "#16977b",
  otherIncome: "#16977b",
  expense: "#d8573a",
  other: "#d8573a",
  system: "#8a8f98",
};
const ZONE_TINT = { income: "#16977b14", expense: "#d8573a14" };
const HATCHED = new Set<WaterfallColumn["kind"]>(["income", "otherIncome", "other"]);
const FONT = "Inter, Avenir, Helvetica, Arial, sans-serif";
const PIXEL_RATIO = 2;

const WIDTH = 1200;
const HEADER = 72;
const ROW_HEIGHT = 44;

/** Breaks a label into lines that fit, at most `maxLines`; the last gets an ellipsis. */
export function wrapText(
  text: string,
  maxWidth: number,
  maxLines: number,
  measure: (s: string) => number,
): string[] {
  const lines: string[] = [];
  let line = "";
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (measure(next) <= maxWidth || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = words[i];
    if (lines.length === maxLines) {
      line = "";
      words.length = 0;
      break;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => {
    const cut = i === lines.length - 1 && lines.length === maxLines ? fit(l, maxWidth, measure) : l;
    return measure(cut) > maxWidth ? fit(cut, maxWidth, measure) : cut;
  });
}

function fit(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && measure(`${out}…`) > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  kind: WaterfallColumn["kind"],
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const color = COLORS[kind];
  ctx.save();
  roundedRect(ctx, x, y, w, h);
  if (!HATCHED.has(kind)) {
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.clip();
  ctx.fillStyle = `${color}59`;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  for (let d = -h; d < w + h; d += 11) {
    ctx.beginPath();
    ctx.moveTo(x + d, y + h);
    ctx.lineTo(x + d + h, y);
    ctx.stroke();
  }
  ctx.restore();
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
  ctx.stroke();
}

function drawVertical(ctx: CanvasRenderingContext2D, spec: WaterfallImageSpec, width: number, height: number) {
  const left = 64;
  const right = width - 16;
  const top = HEADER + 50;
  const bottom = height - 84;
  const slot = (right - left) / spec.columns.length;
  const yOf = (v: number) => bottom - ((v - spec.min) / (spec.max - spec.min)) * (bottom - top);

  for (const zone of spec.zones) {
    ctx.fillStyle = ZONE_TINT[zone.kind];
    ctx.fillRect(left + zone.start * slot, HEADER, zone.count * slot, height - HEADER - 8);
    ctx.font = `600 13px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.textAlign = "center";
    ctx.fillText(zone.title, left + (zone.start + zone.count / 2) * slot, HEADER + 20);
  }
  ctx.font = `12px ${FONT}`;
  for (const tick of spec.ticks) {
    const y = yOf(tick.value);
    line(ctx, left, y, right, y, tick.value === 0 ? AXIS : GRID);
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    ctx.fillText(tick.label, left - 8, y + 4);
  }
  spec.columns.forEach((c, i) => {
    const x = left + i * slot + slot * 0.2;
    const w = slot * 0.6;
    const high = Math.max(c.column.startMinor, c.column.endMinor);
    const low = Math.min(c.column.startMinor, c.column.endMinor);
    const yTop = yOf(high);
    if (i < spec.columns.length - 1) {
      line(ctx, x + w, yOf(c.column.endMinor), x + w + slot * 0.4, yOf(c.column.endMinor), AXIS);
    }
    drawBar(ctx, c.column.kind, x, yTop, w, Math.max(2, yOf(low) - yTop));

    const center = left + (i + 0.5) * slot;
    const total = c.column.kind === "opening" || c.column.kind === "closing";
    ctx.textAlign = "center";
    ctx.fillStyle = INK;
    ctx.font = `${total ? "600 " : ""}13px ${FONT}`;
    ctx.fillText(c.value, center, yTop - 6);

    ctx.font = `${total ? "600 " : ""}13px ${FONT}`;
    const lines = wrapText(c.label, slot - 8, c.note ? 2 : 3, (s) => ctx.measureText(s).width);
    let y = bottom + 20;
    lines.forEach((text, n) => {
      if (n === 0 && c.dotColor) {
        const half = ctx.measureText(text).width / 2;
        ctx.fillStyle = c.dotColor;
        ctx.beginPath();
        ctx.arc(center - half - 8, y - 4, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = INK;
      ctx.fillText(text, center, y);
      y += 16;
    });
    if (c.note) {
      ctx.font = `12px ${FONT}`;
      ctx.fillStyle = MUTED;
      ctx.fillText(c.note, center, y);
    }
  });
}

function drawHorizontal(ctx: CanvasRenderingContext2D, spec: WaterfallImageSpec, width: number) {
  const left = 250;
  // Room after the bars for a value, then for the zones' captions.
  const right = width - 220;
  const top = HEADER + 28;
  const bottom = top + spec.columns.length * ROW_HEIGHT;
  const xOf = (v: number) => left + ((v - spec.min) / (spec.max - spec.min)) * (right - left);

  for (const zone of spec.zones) {
    const y = top + zone.start * ROW_HEIGHT;
    ctx.fillStyle = ZONE_TINT[zone.kind];
    ctx.fillRect(0, y, width, zone.count * ROW_HEIGHT);
    ctx.font = `600 12px ${FONT}`;
    ctx.fillStyle = MUTED;
    ctx.textAlign = "right";
    ctx.fillText(zone.title, width - 12, y + (zone.count * ROW_HEIGHT) / 2 + 4);
  }
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = "center";
  for (const tick of spec.ticks) {
    const x = xOf(tick.value);
    line(ctx, x, top, x, bottom, tick.value === 0 ? AXIS : GRID);
    ctx.fillStyle = MUTED;
    ctx.fillText(tick.label, x, top - 8);
  }
  const barHeight = 26;
  spec.columns.forEach((c, i) => {
    const middle = top + (i + 0.5) * ROW_HEIGHT;
    if (i < spec.columns.length - 1) {
      line(ctx, xOf(c.column.endMinor), middle, xOf(c.column.endMinor), middle + ROW_HEIGHT, AXIS);
    }
    const a = xOf(Math.min(c.column.startMinor, c.column.endMinor));
    const b = xOf(Math.max(c.column.startMinor, c.column.endMinor));
    drawBar(ctx, c.column.kind, a, middle - barHeight / 2, Math.max(2, b - a), barHeight);

    const total = c.column.kind === "opening" || c.column.kind === "closing";
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.font = `${total ? "600 " : ""}13px ${FONT}`;
    ctx.fillText(c.value, Math.max(b, a + 2) + 6, middle + 4);

    let x = 16;
    if (c.dotColor) {
      ctx.fillStyle = c.dotColor;
      ctx.beginPath();
      ctx.arc(x + 4, middle - 1, 4, 0, Math.PI * 2);
      ctx.fill();
      x += 14;
    }
    const noteWidth = c.note ? ctx.measureText(c.note).width + 8 : 0;
    const label = fit(c.label, left - x - 16 - noteWidth, (s) => ctx.measureText(s).width);
    ctx.fillStyle = INK;
    ctx.fillText(label, x, middle + 4);
    if (c.note) {
      const after = x + ctx.measureText(label).width + 8;
      ctx.font = `12px ${FONT}`;
      ctx.fillStyle = MUTED;
      ctx.fillText(c.note, after, middle + 4);
    }
  });
}

/** Draws the chart from its data, not from the page, so the result is the same
 *  in every browser and in the desktop app's webview. */
export function renderWaterfallImage(spec: WaterfallImageSpec): HTMLCanvasElement {
  const vertical = spec.orientation === "vertical";
  const width = vertical ? Math.max(WIDTH, 80 + spec.columns.length * 92) : WIDTH;
  const height = vertical ? 680 : HEADER + 28 + spec.columns.length * ROW_HEIGHT + 16;
  const canvas = document.createElement("canvas");
  canvas.width = width * PIXEL_RATIO;
  canvas.height = height * PIXEL_RATIO;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas is not available");
  ctx.scale(PIXEL_RATIO, PIXEL_RATIO);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.textAlign = "left";
  ctx.fillStyle = INK;
  ctx.font = `600 17px ${FONT}`;
  ctx.fillText(spec.title, 16, 28);
  ctx.font = `13px ${FONT}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(spec.changeLabel, 16, 52);
  const labelWidth = ctx.measureText(spec.changeLabel).width;
  ctx.font = `600 14px ${FONT}`;
  ctx.fillStyle = INK;
  ctx.fillText(spec.change, 16 + labelWidth + 8, 52);

  if (vertical) drawVertical(ctx, spec, width, height);
  else drawHorizontal(ctx, spec, width);
  return canvas;
}

/** To the clipboard where the browser allows it (it needs HTTPS or localhost),
 *  otherwise to a file, so the button always gives the user the picture. */
export async function copyOrDownloadPng(
  canvas: HTMLCanvasElement,
  filename: string,
): Promise<"copied" | "downloaded"> {
  const png = new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("could not create the image"))), "image/png");
  });
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      // The blob goes in as a promise: Safari allows the write only if it starts
      // right within the click.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return "copied";
    } catch {
      // Refused: fall through to the file.
    }
  }
  triggerDownload(await png, filename);
  return "downloaded";
}
