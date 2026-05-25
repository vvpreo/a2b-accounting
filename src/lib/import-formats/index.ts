import type {
  CsvParseResult,
  ImportFormatPlugin,
  ParseInput,
  Translate,
} from "./types";
import { bangkokBankCsvV1 } from "./bangkok-bank-csv-v1";
import { genericCsvV1 } from "./universal-csv";
import { kasikornCsvV1 } from "./kasikorn-csv-v1";
import { kasikornPdfV1 } from "./kasikorn-pdf-v1";

export type {
  CsvParseResult,
  ImportFormatPlugin,
  ParseInput,
  Translate,
} from "./types";

const PLUGINS: ImportFormatPlugin[] = [
  genericCsvV1,
  kasikornCsvV1,
  kasikornPdfV1,
  bangkokBankCsvV1,
];

const REGISTRY: Record<string, ImportFormatPlugin> = Object.fromEntries(
  PLUGINS.map((p) => [p.id, p]),
);

export const DEFAULT_FORMAT_ID = genericCsvV1.id;

export function getFormatPlugin(formatId: string): ImportFormatPlugin {
  return REGISTRY[formatId] ?? genericCsvV1;
}

export function parseByFormat(
  formatId: string,
  input: ParseInput,
  t: Translate,
): Promise<CsvParseResult> {
  return getFormatPlugin(formatId).parse(input, t);
}
