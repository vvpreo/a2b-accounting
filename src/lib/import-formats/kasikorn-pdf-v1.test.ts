import { describe, expect, it } from "vitest";

import type { PdfLine } from "../pdf-extract";
import { linesToUniversalCsv } from "./kasikorn-pdf-v1";

/**
 * Build a PdfLine by passing pairs of [x, str]. The y coordinate is just a
 * descending counter so lines stay in document order; the parser groups by
 * page, not by exact y. width=10 is unused by the parser (only x is read for
 * column assignment).
 */
function line(page: number, y: number, items: Array<[number, string]>): PdfLine {
  return {
    page,
    y,
    items: items.map(([x, str]) => ({ x, y, width: 10, str })),
  };
}

/**
 * Mock header line. Mirrors the layout of the real Kasikorn K-DEPOSIT PDF:
 * "Descriptions", "Channel", "Details" labels are what the parser scans for.
 * X-anchors are the heading text positions; data items in each column live
 * inside the hard-coded boundaries (Date<100, Time<120, Desc<200, Amount<280,
 * Bal<330, Channel<400, Details>=400).
 */
function header(page: number): PdfLine {
  return line(page, 660, [
    [74, "Date"],
    [146, "Descriptions"],
    [209, "Withdrawal / Deposit"],
    [357, "Channel"],
    [460, "Details"],
  ]);
}

const noop = (_k: string, p?: Record<string, unknown>) =>
  p ? JSON.stringify(p) : "translated";

describe("linesToUniversalCsv", () => {
  it("converts a single-page statement, deriving credit/debit from balance delta", () => {
    const lines: PdfLine[] = [
      header(1),
      // Beginning Balance — sets opening balance for the page; not emitted.
      line(1, 641, [
        [68, "01-05-25"],
        [123, "Beginning Balance"],
        [300, "1,000.00"],
      ]),
      // Withdrawal: 1000 → 750 (delta -250).
      line(1, 630, [
        [68, "01-05-25"],
        [101, "10:00"],
        [123, "Debit Card Spending"],
        [234, "250.00"],
        [300, "750.00"],
        [333, "EDC/E-Commerce"],
        [404, "Ref Code EDC00001"],
      ]),
      // Deposit: 750 → 5000 (delta +4250).
      line(1, 618, [
        [68, "02-05-25"],
        [101, "12:30"],
        [123, "Transfer Deposit"],
        [241, "4,250.00"],
        [303, "5,000.00"],
        [333, "Internet/Mobile BBL"],
        [404, "From BBL X5734 MR EXAMPLE"],
      ]),
    ];

    const { universalCsv, errors } = linesToUniversalCsv(lines);
    expect(errors).toEqual([]);
    expect(universalCsv).toBe(
      [
        "occurred_at,credit,debit,balance,peer,bank_description,comment",
        "2025-05-01T10:00:00,,250.00,750.00,,Debit Card Spending · EDC/E-Commerce · Ref Code EDC00001,",
        "2025-05-02T12:30:00,4250.00,,5000.00,BBL X5734 MR EXAMPLE,Transfer Deposit · Internet/Mobile BBL · From BBL X5734 MR EXAMPLE,",
      ].join("\n"),
    );
  });

  it("glues multi-line Details into a single bank_description and peer", () => {
    const lines: PdfLine[] = [
      header(1),
      line(1, 641, [
        [68, "01-05-25"],
        [123, "Beginning Balance"],
        [300, "1,000.00"],
      ]),
      // Main row with truncated Details — wraps to next line.
      line(1, 630, [
        [68, "10-05-25"],
        [101, "14:19"],
        [123, "Payment"],
        [234, "140.00"],
        [303, "860.00"],
        [333, "EDC/K SHOP"],
        [404, "Paid for Ref X3001 PTTST.D CHUTIVAT (A/C"],
      ]),
      // Continuation: no date, Details column only.
      line(1, 622, [[404, "Name: CHUTIWAT PART.,LTD.)"]]),
    ];

    const { universalCsv, errors } = linesToUniversalCsv(lines);
    expect(errors).toEqual([]);
    // Glued Details: peer comes from the FULL string ("Paid for Ref X3001 …
    // PART.,LTD.)"), not the truncated first fragment.
    expect(universalCsv).toContain(
      "PTTST.D CHUTIVAT (A/C Name: CHUTIWAT PART.,LTD.)",
    );
    // peer is the part after "Paid for Ref X3001 ".
    expect(universalCsv).toMatch(
      /,"PTTST\.D CHUTIVAT \(A\/C Name: CHUTIWAT PART\.,LTD\.\)",/,
    );
  });

  it("glues continuation fragments to the column they belong to (Channel + Details)", () => {
    const lines: PdfLine[] = [
      header(1),
      line(1, 641, [
        [68, "01-05-25"],
        [123, "Beginning Balance"],
        [300, "20,000.00"],
      ]),
      line(1, 630, [
        [68, "11-05-25"],
        [101, "12:00"],
        [123, "Cash Withdrawal"],
        [226, "10,000.00"],
        [303, "10,000.00"],
        [333, "ATM Mai Khaolak Beach"],
        [404, "Ref Code ATMD6324"],
      ]),
      // Continuation row touches Channel column only.
      line(1, 622, [[333, "Resort & Spa (Takua ++"]]),
    ];

    const { universalCsv, errors } = linesToUniversalCsv(lines);
    expect(errors).toEqual([]);
    expect(universalCsv).toContain(
      "ATM Mai Khaolak Beach Resort & Spa (Takua ++",
    );
    // Details column stays untouched by the continuation row.
    expect(universalCsv).toContain("Ref Code ATMD6324");
  });

  it("stitches pages by validating Beginning Balance against previous page's last balance", () => {
    const lines: PdfLine[] = [
      header(1),
      line(1, 641, [
        [68, "01-05-25"],
        [123, "Beginning Balance"],
        [300, "1,000.00"],
      ]),
      line(1, 630, [
        [68, "01-05-25"],
        [101, "10:00"],
        [123, "Payment"],
        [234, "100.00"],
        [303, "900.00"],
        [333, "K PLUS"],
        [404, "Paid for Ref X1234 SOMEBODY"],
      ]),
      header(2),
      // Page 2's Beginning Balance MUST equal page 1's last balance (900).
      line(2, 641, [
        [68, "01-05-25"],
        [123, "Beginning Balance"],
        [300, "900.00"],
      ]),
      line(2, 630, [
        [68, "02-05-25"],
        [101, "09:30"],
        [123, "Transfer Deposit"],
        [241, "500.00"],
        [303, "1,400.00"],
        [333, "Internet/Mobile BBL"],
        [404, "From X9999 SELF"],
      ]),
    ];

    const { universalCsv, errors } = linesToUniversalCsv(lines);
    expect(errors).toEqual([]);
    expect(universalCsv).toContain("2025-05-02T09:30:00,500.00,,1400.00");
  });

  it("flags a Beginning Balance mismatch between pages", () => {
    const lines: PdfLine[] = [
      header(1),
      line(1, 641, [
        [68, "01-05-25"],
        [123, "Beginning Balance"],
        [300, "1,000.00"],
      ]),
      line(1, 630, [
        [68, "01-05-25"],
        [101, "10:00"],
        [123, "Payment"],
        [234, "100.00"],
        [303, "900.00"],
        [333, "K PLUS"],
        [404, "Paid for Ref X1234 SOMEBODY"],
      ]),
      header(2),
      // Page 2 says it opens at 999.99 — broken chain.
      line(2, 641, [
        [68, "01-05-25"],
        [123, "Beginning Balance"],
        [300, "999.99"],
      ]),
    ];

    const { errors } = linesToUniversalCsv(lines);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("page 2");
    expect(errors[0]).toContain("Beginning Balance");
  });

  it("uses the universal-CSV layer downstream — final plugin integration", async () => {
    // Smoke-test the full plugin .parse() path via text-only branch refusal.
    // (Real binary path needs pdfjs which we can't load in jsdom.)
    const { kasikornPdfV1 } = await import("./kasikorn-pdf-v1");
    const res = await kasikornPdfV1.parse(
      { kind: "text", text: "not binary" },
      noop,
    );
    expect(res.rows).toEqual([]);
    expect(res.errors).toHaveLength(1);
  });

  it("skips Ref Code details when extracting peer (only Transfer/Payment populates peer)", () => {
    const lines: PdfLine[] = [
      header(1),
      line(1, 641, [
        [68, "01-05-25"],
        [123, "Beginning Balance"],
        [300, "1,000.00"],
      ]),
      line(1, 630, [
        [68, "01-05-25"],
        [101, "10:00"],
        [123, "Debit Card Spending"],
        [234, "100.00"],
        [303, "900.00"],
        [333, "EDC/E-Commerce"],
        [404, "Ref Code EDC25445"],
      ]),
    ];

    const { universalCsv, errors } = linesToUniversalCsv(lines);
    expect(errors).toEqual([]);
    // The "peer" column (5th field) should be empty for Ref Code rows.
    const row = universalCsv.split("\n")[1];
    const cols = row.split(",");
    expect(cols[0]).toBe("2025-05-01T10:00:00");
    expect(cols[4]).toBe(""); // peer
  });
});
