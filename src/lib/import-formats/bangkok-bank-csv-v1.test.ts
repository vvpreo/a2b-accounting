import { describe, expect, it } from "vitest";

import { bankCsvToUniversal, parseBblDate } from "./bangkok-bank-csv-v1";

// Synthetic data only — no real account / card numbers. The bank exports
// rows newest-first; the parser must reverse them.
const BBL_FIXTURE = `Account Nickname,"",Ledger Balance,"5,000.00",
Account Number,"XXX-X-XXXXXX",Available Balance,"5,000.00",

,,
"Be1st Card Number","XXXX-XXxx-xxxx-XXXX",

,Date,Description,Debit,Credit,Balance,Channel,
" ","05 Apr 2026 12:00","PromptPay Transfer/Top Up eWallet","1,000.00","","5,000.00","MOB",
" ","04 Apr 2026 09:30","Interbank Transfer","","2,000.00","6,000.00","MOB",
" ","03 Apr 2026 18:15","Withdrawal Fee - Other Bank ATM","20.00","","4,000.00","ATMO",
" ","03 Apr 2026 18:15","Cash - Other Bank ATM","1,000.00","","4,020.00","ATMO",
" ","02 Apr 2026 10:00","Payment for Goods /Services","500.00","","5,020.00","MOB",
,,"Total","2,520.00","2,000.00",,,,,,,,,
Disclaimer: ...`;

const EXPECTED_UNIVERSAL = `occurred_at,credit,debit,balance,peer,bank_description,comment
2026-04-02T10:00:00,,500.00,5020.00,,Payment for Goods /Services · MOB,
2026-04-03T18:15:00,,1000.00,4020.00,,Cash - Other Bank ATM · ATMO,
2026-04-03T18:15:00,,20.00,4000.00,,Withdrawal Fee - Other Bank ATM · ATMO,
2026-04-04T09:30:00,2000.00,,6000.00,,Interbank Transfer · MOB,
2026-04-05T12:00:00,,1000.00,5000.00,,PromptPay Transfer/Top Up eWallet · MOB,`;

describe("bangkok-bank bankCsvToUniversal", () => {
  it("reverses the export, drops Total/header rows, and preserves intra-minute order", () => {
    const { universalCsv, errors } = bankCsvToUniversal(BBL_FIXTURE);
    expect(errors).toEqual([]);
    expect(universalCsv).toBe(EXPECTED_UNIVERSAL);
  });

  it("reports an error when the table header is missing", () => {
    const noHeader =
      "Account Number,XXX,,\nrandom,line,here,\nDisclaimer: nope";
    const { universalCsv, errors } = bankCsvToUniversal(noHeader);
    expect(universalCsv).toBe("");
    expect(errors).toEqual([
      "bangkok-bank: transaction table header not found",
    ]);
  });

  it("reports rows whose date cell can't be parsed instead of dropping them", () => {
    const badDate = `,Date,Description,Debit,Credit,Balance,Channel,
" ","not-a-date","Foo","1.00","","2.00","MOB",
,,"Total","1.00","0.00",,,
`;
    const { universalCsv, errors } = bankCsvToUniversal(badDate);
    expect(errors).toEqual([
      'bangkok-bank: row 2 has an unrecognized date "not-a-date"',
    ]);
    expect(universalCsv).toBe(
      "occurred_at,credit,debit,balance,peer,bank_description,comment",
    );
  });

  it("keeps date-only AUTO rows (interest, withholding tax) in the balance chain", () => {
    // Interest Credit / Withholding Tax come as "25-Jun-26" with no time.
    const fixture = `,Date,Description,Debit,Credit,Balance,Channel,
" ","26 Jun 2026 14:59","Payment for Goods /Services","3,000.00","","54,129.97","MOB",
" ","25-Jun-26","Withholding Tax","134.2","","57,129.97","AUTO",
" ","25-Jun-26","Interest Credit","","894.65","57,264.17","AUTO",
" ","22 Jun 2026 17:10","Payment for Goods /Services","1,856.00","","56,369.52","MOB",
,,"Total","4,990.20","894.65",,,
`;
    const { universalCsv, errors } = bankCsvToUniversal(fixture);
    expect(errors).toEqual([]);
    expect(universalCsv).toBe(`occurred_at,credit,debit,balance,peer,bank_description,comment
2026-06-22T17:10:00,,1856.00,56369.52,,Payment for Goods /Services · MOB,
2026-06-25T00:00:00,894.65,,57264.17,,Interest Credit · AUTO,
2026-06-25T00:00:00,,134.2,57129.97,,Withholding Tax · AUTO,
2026-06-26T14:59:00,,3000.00,54129.97,,Payment for Goods /Services · MOB,`);
  });

  it("gives a date-only row the time of the previous same-day row", () => {
    const fixture = `,Date,Description,Debit,Credit,Balance,Channel,
" ","25 Jun 2026 18:00","Payment","10.00","","70.00","MOB",
" ","25-Jun-26","Withholding Tax","10.00","","80.00","AUTO",
" ","25 Jun 2026 09:30","Payment","10.00","","90.00","MOB",
`;
    const { universalCsv, errors } = bankCsvToUniversal(fixture);
    expect(errors).toEqual([]);
    expect(universalCsv.split("\n").slice(1).map((l) => l.split(",")[0])).toEqual([
      "2026-06-25T09:30:00",
      "2026-06-25T09:30:00",
      "2026-06-25T18:00:00",
    ]);
  });
});

describe("parseBblDate", () => {
  it("parses the canonical 'DD MMM YYYY HH:MM' shape", () => {
    expect(parseBblDate("27 Apr 2026 11:50")).toEqual({ date: "2026-04-27", time: "11:50" });
    expect(parseBblDate("01 Jan 2025 00:00")).toEqual({ date: "2025-01-01", time: "00:00" });
    expect(parseBblDate("9 Sep 2026 8:05")).toEqual({ date: "2026-09-09", time: "08:05" });
  });

  it("parses date-only cells, including 'DD-MMM-YY'", () => {
    expect(parseBblDate("25-Jun-26")).toEqual({ date: "2026-06-25", time: null });
    expect(parseBblDate("5-Jan-2026")).toEqual({ date: "2026-01-05", time: null });
    expect(parseBblDate("25 Jun 2026")).toEqual({ date: "2026-06-25", time: null });
  });

  it("returns null for malformed input", () => {
    expect(parseBblDate("")).toBeNull();
    expect(parseBblDate("2026-04-27 11:50")).toBeNull();
    expect(parseBblDate("27 Foo 2026 11:50")).toBeNull();
    expect(parseBblDate("25-Jun-2")).toBeNull();
    expect(parseBblDate("Total")).toBeNull();
  });
});
