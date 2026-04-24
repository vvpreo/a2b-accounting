export interface Bank {
  id: string;
  name: string;
  countryCode: string;
  bic?: string;
}

export const BANKS: Record<string, Bank> = {
  "bangkok-bank": {
    id: "bangkok-bank",
    name: "Bangkok Bank",
    countryCode: "TH",
    bic: "BKKBTHBK",
  },
};

export const BANK_LIST: Bank[] = Object.values(BANKS);
