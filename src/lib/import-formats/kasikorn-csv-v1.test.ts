import { describe, expect, it } from "vitest";

import { bankCsvToUniversal, extractPeer } from "./kasikorn-csv-v1";

// Fixture mirrors the real K-DEPOSIT export structure but uses synthetic
// data only — no real account numbers, names, or counterparties. Personal
// data must never be committed; see CLAUDE.md.
const KASIKORN_FIXTURE = `รายการเดินบัญชีเงินฝากออมทรัพย์ (มีรายละเอียด),,,,,,,,,,,,
K-DEPOSIT STATEMENT OF SAVING ACCOUNT (WITH DETAIL),,,,,,,,,,,,
,Ref. No. DD.048 : NXXXXXXXXXX/2569,Page 1/1,,,0482,,,,,,,
,Account,"MR. EXAMPLE NAME
1/1 Test Road, Test City",,,,,Reference Code,,,,XXXXXXXXXX,
,,,,,,,Account Number,,,,XXX-X-XXXXX-X,
,,,,,,,Period,,,,01/01/2025 - 31/12/2025,
,,,,,,,Owner Branch,,,,Test Branch,
,,,,,,,ENDING BALANCE,,,,,"5,000.00"
,,,,,,,TOTAL WITHDRAWAL,,3,,ITEMS,"6,000.00"
,,,,,,,TOTAL DEPOSIT,,2,,ITEMS,"11,000.00"
,Date,"Time/
Eff.Date",Descriptions,Withdrawal,,Deposit,,"Outstanding
Balance",,Channel,,Details
,01-01-25,,Beginning Balance,,,,,"0.00",,,,
,02-01-25,10:30,Transfer Deposit,,,"10,000.00",,"10,000.00",,Internet/Mobile BBL,,From BBL X1234 MR EXAMPLE PEER
,03-01-25,14:15,Cash Withdrawal,"2,000.00",,,,"8,000.00",,ATM,,Ref Code ATM00001
,03-01-25,14:15,Fee,10.00,,,,"7,990.00",,ATM,,Ref Code ATM00001
,04-01-25,9:05,Transfer Withdrawal,"3,000.00",,,,"4,990.00",,K PLUS,,To X9999 MS. ANOTHER PEER
,05-01-25,11:00,Payment,"1,000.00",,,,"3,990.00",,K PLUS,,"Paid for Ref X4242 INDEX LIVING MALL PUBLIC CO.,LTD."
,06-01-25,12:00,Transfer Deposit,,,"1,010.00",,"5,000.00",,K PLUS,,From X1111 MR SELF
`;

const EXPECTED_UNIVERSAL = `occurred_at,credit,debit,balance,peer,bank_description,comment
2025-01-02T10:30:00,10000.00,,10000.00,BBL X1234 MR EXAMPLE PEER,Transfer Deposit · Internet/Mobile BBL · From BBL X1234 MR EXAMPLE PEER,
2025-01-03T14:15:00,,2000.00,8000.00,,Cash Withdrawal · ATM · Ref Code ATM00001,
2025-01-03T14:15:00,,10.00,7990.00,,Fee · ATM · Ref Code ATM00001,
2025-01-04T09:05:00,,3000.00,4990.00,X9999 MS. ANOTHER PEER,Transfer Withdrawal · K PLUS · To X9999 MS. ANOTHER PEER,
2025-01-05T11:00:00,,1000.00,3990.00,"INDEX LIVING MALL PUBLIC CO.,LTD.","Payment · K PLUS · Paid for Ref X4242 INDEX LIVING MALL PUBLIC CO.,LTD.",
2025-01-06T12:00:00,1010.00,,5000.00,X1111 MR SELF,Transfer Deposit · K PLUS · From X1111 MR SELF,`;

describe("bankCsvToUniversal", () => {
  it("converts a Kasikorn statement to universal CSV", () => {
    const { universalCsv, errors } = bankCsvToUniversal(KASIKORN_FIXTURE);
    expect(errors).toEqual([]);
    expect(universalCsv).toBe(EXPECTED_UNIVERSAL);
  });

  it("reports an error when the table header is missing", () => {
    const noHeader = "K-DEPOSIT STATEMENT,,,\nrandom,line,here,";
    const { universalCsv, errors } = bankCsvToUniversal(noHeader);
    expect(universalCsv).toBe("");
    expect(errors).toEqual([
      "kasikorn: transaction table header not found",
    ]);
  });

  it("skips rows whose date cell isn't a DD-MM-YY date", () => {
    const onlyHeader = `,Date,"Time/
Eff.Date",Descriptions,Withdrawal,,Deposit,,"Outstanding
Balance",,Channel,,Details
,not-a-date,,Some row,,,,,,,,,
,01-01-25,,Beginning Balance,,,,,"0.00",,,,
`;
    const { universalCsv, errors } = bankCsvToUniversal(onlyHeader);
    expect(errors).toEqual([]);
    expect(universalCsv).toBe(
      "occurred_at,credit,debit,balance,peer,bank_description,comment",
    );
  });
});

describe("extractPeer", () => {
  it("returns null for Ref Code lines", () => {
    expect(extractPeer("Ref Code ATM47002")).toBeNull();
    expect(extractPeer("Ref Code PCB09400")).toBeNull();
    expect(extractPeer("Ref Code EDC05445")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractPeer("")).toBeNull();
    expect(extractPeer("   ")).toBeNull();
  });

  it("extracts the tail after From/To", () => {
    expect(extractPeer("From BBL X1234 MR PEER")).toBe("BBL X1234 MR PEER");
    expect(extractPeer("To X9999 MS. PEER")).toBe("X9999 MS. PEER");
    expect(extractPeer("To PromptPay X6096 SOMEONE")).toBe(
      "PromptPay X6096 SOMEONE",
    );
  });

  it("strips the reference code from Paid for Ref lines", () => {
    expect(extractPeer("Paid for Ref X8826 T2P")).toBe("T2P");
    expect(extractPeer("Paid for Ref X4190 AIS Fibre")).toBe("AIS Fibre");
    expect(
      extractPeer("Paid for Ref X1777 INDEX LIVING MALL PUBLIC CO.,LTD."),
    ).toBe("INDEX LIVING MALL PUBLIC CO.,LTD.");
  });

  it("returns null for unknown shapes", () => {
    expect(extractPeer("Some unrecognised note")).toBeNull();
  });
});
