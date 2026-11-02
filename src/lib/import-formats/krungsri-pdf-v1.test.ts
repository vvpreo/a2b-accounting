import { describe, expect, it } from "vitest";

import type { PdfLine } from "../pdf-extract";
import { extractPeer, linesToUniversalCsv } from "./krungsri-pdf-v1";

/** Items as [x, str] or, for right-aligned amounts, [x, str, width]. */
function line(
  page: number,
  y: number,
  items: Array<[number, string, number?]>,
): PdfLine {
  return {
    page,
    y,
    items: items.map(([x, str, width]) => ({ x, y, width: width ?? 10, str })),
  };
}

/** The table header spans three baselines, like in the real PDF. */
function header(page: number): PdfLine[] {
  return [
    line(page, 559, [[354.7, "Outstanding"]]),
    line(page, 554, [
      [20, "Date/Time"],
      [106, "Transaction"],
      [228.9, "Withdrawal/Deposit"],
      [420, "Channel"],
      [468, "Description"],
    ]),
    line(page, 549, [[362.8, "Balance"]]),
  ];
}

/** Amounts placed by their right edge: 276 withdrawal, 334 deposit, 392 balance. */
function row(
  page: number,
  y: number,
  head: string,
  amounts: { withdrawal?: string; deposit?: string; balance: string },
  channel: string,
  description?: string,
): PdfLine {
  const amount = (right: number, str: string): [number, string, number] => {
    const width = str.length * 3;
    return [right - width, str, width];
  };
  const items: Array<[number, string, number?]> = [[24, head]];
  if (amounts.withdrawal) items.push(amount(276, amounts.withdrawal));
  if (amounts.deposit) items.push(amount(334, amounts.deposit));
  items.push(amount(392, amounts.balance));
  items.push([420, channel]);
  if (description) items.push([468, description]);
  return line(page, y, items);
}

function totals(
  page: number,
  withdrawal: [number, string],
  deposit: [number, string],
): PdfLine[] {
  return [
    line(page, 98, [
      [24, "Total Withdrawal"],
      [106, `${withdrawal[0]} items`],
      [194, withdrawal[1]],
    ]),
    line(page, 65, [
      [24, "Total Deposit"],
      [106, `${deposit[0]} items`],
      [299, deposit[1]],
    ]),
  ];
}

function footer(page: number): PdfLine[] {
  return [
    line(page, 28, [[248.1, "Bank of Ayudhya Public Company Limited."]]),
    line(page, 16, [[149.3, "1222 Rama III Road, Bangkok 10120 Phone : 1572"]]),
  ];
}

describe("linesToUniversalCsv", () => {
  it("takes the direction from the column, with no opening balance row", () => {
    const { universalCsv, errors } = linesToUniversalCsv([
      ...header(1),
      row(1, 530, "05/03/2026 10:15:20 Transfer Deposit", { deposit: "2,500.00", balance: "2,800.50" }, "MOBILE", "KBANK MR. JOHN DO..."),
      line(1, 512, [[468, "From Acc No. : X123456"]]),
      row(1, 494, "05/03/2026 10:16:05 Spending", { withdrawal: "1,000.00", balance: "1,800.50" }, "POS", "From Card No. 1234567890"),
      ...totals(1, [1, "1,000.00"], [1, "2,500.00"]),
      ...footer(1),
    ]);
    expect(errors).toEqual([]);
    expect(universalCsv.split("\n")).toEqual([
      "occurred_at,credit,debit,balance,peer,bank_description,comment",
      "2026-03-05T10:15:20,2500.00,,2800.50,KBANK MR. JOHN DO X123456,Transfer Deposit · MOBILE · KBANK MR. JOHN DO... From Acc No. : X123456,",
      "2026-03-05T10:16:05,,1000.00,1800.50,,Spending · POS · From Card No. 1234567890,",
    ]);
  });

  it("reads a Spending row in the Deposit column as a credit (card refund)", () => {
    const { universalCsv, errors } = linesToUniversalCsv([
      ...header(1),
      row(1, 530, "09/03/2026 11:05:33 Spending", { deposit: "100.00", balance: "120.00" }, "POS", "From Card No. 1234567890"),
      ...totals(1, [0, "0.00"], [1, "100.00"]),
    ]);
    expect(errors).toEqual([]);
    expect(universalCsv.split("\n")[1]).toBe(
      "2026-03-09T11:05:33,100.00,,120.00,,Spending · POS · From Card No. 1234567890,",
    );
  });

  it("identifies long right-aligned amounts by their right edge", () => {
    const { universalCsv, errors } = linesToUniversalCsv([
      ...header(1),
      row(1, 530, "01/02/2026 10:00:00 Transfer Deposit", { deposit: "1,250,000.00", balance: "1,250,000.00" }, "BAHTNET"),
      row(1, 512, "01/02/2026 10:05:00 Fee", { withdrawal: "1,000,000.00", balance: "250,000.00" }, "ACH"),
      ...totals(1, [1, "1,000,000.00"], [1, "1,250,000.00"]),
    ]);
    expect(errors).toEqual([]);
    expect(universalCsv.split("\n").slice(1)).toEqual([
      "2026-02-01T10:00:00,1250000.00,,1250000.00,,Transfer Deposit · BAHTNET,",
      "2026-02-01T10:05:00,,1000000.00,250000.00,,Fee · ACH,",
    ]);
  });

  it("keeps the footer out of the last row and a split row whole across pages", () => {
    const { universalCsv, errors } = linesToUniversalCsv([
      line(1, 766, [[568.5, "Page 1 / 2"]]),
      ...header(1),
      row(1, 62, "11/03/2026 13:20:10 Payment - QR P...", { withdrawal: "60.00", balance: "240.00" }, "MOBILE", "SOME MERCHANT..."),
      ...footer(1),
      line(2, 766, [[568.5, "Page 2 / 2"]]),
      ...header(2),
      line(2, 708, [[468, "To Acc No. : X000001"]]),
      ...totals(2, [1, "60.00"], [0, "0.00"]),
      ...footer(2),
    ]);
    expect(errors).toEqual([]);
    expect(universalCsv.split("\n")[1]).toBe(
      "2026-03-11T13:20:10,,60.00,240.00,SOME MERCHANT X000001,Payment - QR P... · MOBILE · SOME MERCHANT... To Acc No. : X000001,",
    );
  });

  it("keeps a 00:00:00 interest row in its statement position within a day", () => {
    const { universalCsv, errors } = linesToUniversalCsv([
      ...header(1),
      row(1, 530, "29/06/2026 12:00:00 Spending", { withdrawal: "10.00", balance: "90.00" }, "POS"),
      row(1, 512, "29/06/2026 00:00:00 Interest Deposit", { deposit: "1.00", balance: "91.00" }, "Others"),
      row(1, 494, "29/06/2026 00:00:00 Tax", { withdrawal: "0.15", balance: "90.85" }, "Others"),
      row(1, 476, "30/06/2026 00:00:00 Fee", { withdrawal: "0.85", balance: "90.00" }, "ACH"),
      ...totals(1, [3, "11.00"], [1, "1.00"]),
    ]);
    expect(errors).toEqual([]);
    expect(universalCsv.split("\n").slice(1).map((l) => l.split(",")[0])).toEqual([
      "2026-06-29T12:00:00",
      "2026-06-29T12:00:00",
      "2026-06-29T12:00:00",
      "2026-06-30T00:00:00",
    ]);
  });

  it("reports a broken balance chain", () => {
    const { errors } = linesToUniversalCsv([
      ...header(1),
      row(1, 530, "01/02/2026 10:00:00 Spending", { withdrawal: "10.00", balance: "90.00" }, "POS"),
      row(1, 512, "01/02/2026 11:00:00 Spending", { withdrawal: "10.00", balance: "70.00" }, "POS"),
      ...totals(1, [2, "20.00"], [0, "0.00"]),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/balance delta -20\.00 doesn't match amount 10\.00/);
  });

  it("reports totals that disagree with the parsed rows", () => {
    const { errors } = linesToUniversalCsv([
      ...header(1),
      row(1, 530, "01/02/2026 10:00:00 Spending", { withdrawal: "10.00", balance: "90.00" }, "POS"),
      ...totals(1, [2, "20.00"], [0, "0.00"]),
    ]);
    expect(errors).toEqual([
      "krungsri-pdf: Total Withdrawal says 2 items / 20.00, parsed 1 items / 10.00",
    ]);
  });

  it("reports a statement without the totals summary", () => {
    const { errors } = linesToUniversalCsv([
      ...header(1),
      row(1, 530, "01/02/2026 10:00:00 Spending", { withdrawal: "10.00", balance: "90.00" }, "POS"),
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/Total Withdrawal summary not found/);
    expect(errors[1]).toMatch(/Total Deposit summary not found/);
  });

  it("reports a page without the table header", () => {
    const { universalCsv, errors } = linesToUniversalCsv([
      line(1, 500, [[24, "Unexpected page"]]),
    ]);
    expect(universalCsv).toBe("");
    expect(errors[0]).toMatch(/page 1 — transaction table header not found/);
  });
});

describe("extractPeer", () => {
  it("joins the name and the account", () => {
    expect(extractPeer(["KBANK MR. JOHN DO...", "To Acc No. : X123456"])).toBe(
      "KBANK MR. JOHN DO X123456",
    );
  });

  it("uses a lone account number", () => {
    expect(extractPeer(["To Acc No. : X123456"])).toBe("X123456");
  });

  it("finds no peer in the own card or e-wallet lines", () => {
    expect(extractPeer(["From Card No. 1234567890"])).toBe("");
    expect(extractPeer(["Transfer to E-wallet"])).toBe("");
    expect(extractPeer([])).toBe("");
  });
});
