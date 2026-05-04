export interface ImportFormat {
  id: string;
  name: string;
}

export interface AccountPreset {
  id: string;
  name: string;
  defaultCurrency: string;
  /** Optional default UTC offset to preselect in the import wizard when the
   *  user is importing into an account of this preset. Bank statements rarely
   *  include the timezone explicitly, so the preset declares the bank's local
   *  zone. ImportDialog falls back to the system offset when omitted. */
  defaultTimezoneOffset?: string;
  supportedFormats: ImportFormat[];
}

export const IMPORT_FORMATS: Record<string, ImportFormat> = {
  "generic-csv-v1": {
    id: "generic-csv-v1",
    name: "Generic CSV (occurred_at,credit,debit,balance,peer,bank_description,comment)",
  },
  "bangkok-bank-csv-v1": {
    id: "bangkok-bank-csv-v1",
    name: "Bangkok Bank statement CSV",
  },
  "kasikorn-csv-v1": {
    id: "kasikorn-csv-v1",
    name: "Kasikorn statement CSV (K-DEPOSIT)",
  },
};

export const ACCOUNT_PRESETS: AccountPreset[] = [
  {
    id: "generic",
    name: "Generic",
    defaultCurrency: "USD",
    supportedFormats: [IMPORT_FORMATS["generic-csv-v1"]],
  },
  {
    id: "bangkok-bank",
    name: "Bangkok Bank",
    defaultCurrency: "THB",
    defaultTimezoneOffset: "+07:00",
    supportedFormats: [
      IMPORT_FORMATS["bangkok-bank-csv-v1"],
      IMPORT_FORMATS["generic-csv-v1"],
    ],
  },
  {
    id: "kasikorn",
    name: "Kasikorn Bank",
    defaultCurrency: "THB",
    defaultTimezoneOffset: "+07:00",
    supportedFormats: [
      IMPORT_FORMATS["kasikorn-csv-v1"],
      IMPORT_FORMATS["generic-csv-v1"],
    ],
  },
];

export function findPresetByName(name: string): AccountPreset | undefined {
  return ACCOUNT_PRESETS.find((p) => p.name === name);
}
