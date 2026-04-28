export interface ImportFormat {
  id: string;
  name: string;
}

export interface AccountPreset {
  id: string;
  name: string;
  defaultCurrency: string;
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
    supportedFormats: [
      IMPORT_FORMATS["bangkok-bank-csv-v1"],
      IMPORT_FORMATS["generic-csv-v1"],
    ],
  },
];

export function findPresetByName(name: string): AccountPreset | undefined {
  return ACCOUNT_PRESETS.find((p) => p.name === name);
}
