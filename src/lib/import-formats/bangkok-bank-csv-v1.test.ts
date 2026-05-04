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

  it("skips rows whose date cell isn't a valid 'DD MMM YYYY HH:MM'", () => {
    const onlyHeader = `,Date,Description,Debit,Credit,Balance,Channel,
" ","not-a-date","Foo","1.00","","2.00","MOB",
,,"Total","1.00","0.00",,,
`;
    const { universalCsv, errors } = bankCsvToUniversal(onlyHeader);
    expect(errors).toEqual([]);
    expect(universalCsv).toBe(
      "occurred_at,credit,debit,balance,peer,bank_description,comment",
    );
  });
});

describe("parseBblDate", () => {
  it("converts BBL date strings to ISO-without-offset", () => {
    expect(parseBblDate("27 Apr 2026 11:50")).toBe("2026-04-27T11:50:00");
    expect(parseBblDate("01 Jan 2025 00:00")).toBe("2025-01-01T00:00:00");
    expect(parseBblDate("9 Sep 2026 8:05")).toBe("2026-09-09T08:05:00");
  });

  it("returns null for malformed input", () => {
    expect(parseBblDate("")).toBeNull();
    expect(parseBblDate("2026-04-27 11:50")).toBeNull();
    expect(parseBblDate("27 Foo 2026 11:50")).toBeNull();
    expect(parseBblDate("Total")).toBeNull();
  });
});
