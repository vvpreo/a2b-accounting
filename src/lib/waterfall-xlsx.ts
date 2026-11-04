import type { CellObject } from "write-excel-file/browser";

import { triggerDownload } from "./api";
import { WaterfallColumn } from "./report-waterfall";

export interface WaterfallSheetLabels {
  title: string;
  period: string;
  periodValue: string;
  currency: string;
  currencyValue: string;
  rate: string;
  rateValue: string;
  change: string;
  colColumn: string;
  colSection: string;
  colChange: string;
  colBalance: string;
  section: (kind: WaterfallColumn["kind"]) => string;
  columnName: (column: WaterfallColumn) => string;
}

type Cell = CellObject | null;

const MONEY_FORMAT = "#,##0.00";
const money = (minor: number, bold = false): Cell => ({
  value: minor / 100,
  format: MONEY_FORMAT,
  ...(bold ? { fontWeight: "bold" as const } : {}),
});
const text = (value: string, bold = false): Cell => ({
  value,
  ...(bold ? { fontWeight: "bold" as const } : {}),
});

/** The numbers the chart is drawn from, with what they were computed for above
 *  them: no transactions and no breakdown. */
export function buildWaterfallSheet(columns: WaterfallColumn[], labels: WaterfallSheetLabels): Cell[][] {
  const first = columns[0];
  const last = columns[columns.length - 1];
  const change = first && last ? last.endMinor - first.endMinor : 0;
  return [
    [text(labels.title, true)],
    [text(labels.period), text(labels.periodValue)],
    [text(labels.currency), text(labels.currencyValue)],
    [text(labels.rate), text(labels.rateValue)],
    [text(labels.change), money(change, true)],
    [],
    [text(labels.colColumn, true), text(labels.colSection, true), text(labels.colChange, true), text(labels.colBalance, true)],
    ...columns.map((column) => {
      const total = column.kind === "opening" || column.kind === "closing";
      return [
        text(labels.columnName(column), total),
        text(labels.section(column.kind)),
        total ? null : money(column.deltaMinor),
        money(column.endMinor, total),
      ];
    }),
  ];
}

export async function downloadWaterfallXlsx(sheet: Cell[][], filename: string, sheetName: string) {
  // Only this button needs the library: it loads when pressed.
  const { default: writeExcelFile } = await import("write-excel-file/browser");
  const blob = await writeExcelFile(sheet, {
    sheet: sheetName,
    columns: [{ width: 38 }, { width: 24 }, { width: 16 }, { width: 16 }],
  }).toBlob();
  triggerDownload(blob, filename);
}
