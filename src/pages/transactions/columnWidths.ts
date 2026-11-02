/// Every column of the transactions table, in table order.
export const TABLE_COLUMNS = [
  "context",
  "example",
  "select",
  "account",
  "date",
  "credit",
  "debit",
  "balance",
  "note",
  "suggestion",
  "category",
  "link",
  "delta",
  "peer",
  "bank_description",
] as const;
export type TableColumn = (typeof TABLE_COLUMNS)[number];
export type ColumnWidths = Partial<Record<TableColumn, number>>;

/// For a column that was hidden when the widths were frozen and is shown later.
export const COLUMN_WIDTH_FALLBACK = 160;
const COLUMN_WIDTH_MIN = 24;
const COLUMN_WIDTH_MAX = 3000;

export const clampColumnWidth = (w: number) =>
  Math.round(Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, w)));

/// Reads the `app_settings` value; anything unusable counts as "no width".
export function parseColumnWidths(raw: string | null): ColumnWidths {
  if (!raw) return {};
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    const widths: ColumnWidths = {};
    for (const column of TABLE_COLUMNS) {
      const w = saved?.[column];
      if (typeof w === "number" && Number.isFinite(w)) {
        widths[column] = clampColumnWidth(w);
      }
    }
    return widths;
  } catch {
    return {};
  }
}

export function totalColumnWidth(
  columns: readonly TableColumn[],
  widths: ColumnWidths,
): number {
  return columns.reduce((sum, c) => sum + (widths[c] ?? COLUMN_WIDTH_FALLBACK), 0);
}

/// Width at which a column's header and all its cells show in full. Clones the
/// column into a hidden auto-layout table (`.col-fit-probe`, which also releases
/// the absolutely positioned cell contents) and reads what that table needs.
export function fittedColumnWidth(table: HTMLTableElement, index: number): number {
  const probe = document.createElement("table");
  probe.className = "col-fit-probe";
  const addRow = (cell: Element) => {
    probe.insertRow().appendChild(cell);
  };
  const th = table.tHead!.rows[0].cells[index].cloneNode(true) as HTMLElement;
  th.querySelector(".col-resize-handle")?.remove();
  addRow(th);
  for (const row of table.tBodies[0].rows) {
    // Dated rows that aren't separators hold one cell per column.
    if (row.dataset.ts === undefined || row.classList.contains("month-separator")) {
      continue;
    }
    addRow(row.cells[index].cloneNode(true) as HTMLElement);
  }
  table.parentElement!.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return Math.ceil(width) + 1;
}

/// Pointer capture on a column handle: reports the horizontal offset from the
/// drag's start, then `onEnd` once the button is released.
export function trackHandleDrag(
  e: React.PointerEvent<HTMLSpanElement>,
  onMove: (dx: number) => void,
  onEnd: () => void,
) {
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const move = (ev: PointerEvent) => onMove(ev.clientX - startX);
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    onEnd();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}
