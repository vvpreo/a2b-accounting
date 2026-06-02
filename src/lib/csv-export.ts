import Papa from "papaparse";

import type { Transaction } from "./api";

/// Column order of the standard import/export CSV (`generic-csv-v1`). Kept in
/// lockstep with the universal parser in `import-formats/universal-csv.ts` so an
/// exported file re-imports cleanly.
const CSV_COLUMNS = [
  "occurred_at",
  "credit",
  "debit",
  "balance",
  "peer",
  "bank_description",
  "comment",
] as const;

/// UTF-8 byte-order mark. Excel (notably on macOS) won't auto-detect UTF-8
/// without it and renders Cyrillic as mojibake. PapaParse strips a leading BOM
/// on parse, so prepending it is safe for the export → re-import round-trip.
const UTF8_BOM = "﻿";

/// Serialize an account's transactions into the standard CSV format used by the
/// importer. Rules:
///  - The file starts with a UTF-8 BOM so Excel opens non-ASCII text correctly.
///  - `occurred_at` is the raw UTC instant (ISO-8601 with `Z`) so re-import maps
///    back to the exact same `occurred_at_utc` regardless of the chosen offset.
///  - The zero side of credit/debit is left blank (matching the import sample).
///  - Synthetic balance-correction rows (`isCorrecting`) are excluded — they are
///    internal artifacts, not user data.
export function buildAccountCsv(txns: Transaction[]): string {
  const rows = txns
    .filter((t) => !t.isCorrecting)
    .map((t) => ({
      occurred_at: t.occurredAtUtc,
      credit: Number(t.credit) === 0 ? "" : t.credit,
      debit: Number(t.debit) === 0 ? "" : t.debit,
      balance: t.balance,
      peer: t.peer ?? "",
      bank_description: t.bankDescription ?? "",
      comment: t.comment ?? "",
    }));
  const csv = Papa.unparse(rows, {
    columns: CSV_COLUMNS as unknown as string[],
    header: true,
  });
  return UTF8_BOM + csv;
}
