/** Single text fragment extracted from a PDF page. */
export interface PdfTextItem {
  /** Left baseline X. */
  x: number;
  /** Baseline Y. PDF.js measures Y from the page bottom — higher = further
   *  up the page. We keep the raw value so the parser can sort top-down by
   *  `-y`. */
  y: number;
  /** Width in PDF units. */
  width: number;
  /** Trimmed text. Empty strings are skipped during extraction. */
  str: string;
}

/** All text fragments that share roughly the same baseline (one visual line). */
export interface PdfLine {
  /** 1-based page number. */
  page: number;
  /** Rounded Y baseline used as the grouping key. */
  y: number;
  /** Items sorted left-to-right. */
  items: PdfTextItem[];
}

export class PdfPasswordRequiredError extends Error {
  constructor() {
    super("PDF requires a password");
    this.name = "PdfPasswordRequiredError";
  }
}

export class PdfPasswordIncorrectError extends Error {
  constructor() {
    super("Incorrect PDF password");
    this.name = "PdfPasswordIncorrectError";
  }
}

/**
 * Extract every page of a PDF as positioned text lines, ready for table-shaped
 * parsing. Items with empty strings are dropped; remaining items on the same
 * baseline (within 1 unit) are grouped into one `PdfLine` and sorted by X.
 *
 * `password` is forwarded to PDF.js — pass `undefined` for unencrypted PDFs.
 * Encryption failures are surfaced as `PdfPasswordRequiredError` (no password
 * provided) or `PdfPasswordIncorrectError` (wrong password).
 */
/**
 * Polyfill `ReadableStream.prototype[Symbol.asyncIterator]` (and the related
 * `.values()` method) when missing. The Tauri 2 WebKit on macOS ships a
 * `ReadableStream` without these methods, but pdfjs-dist v5 uses
 * `for await (const value of readableStream)` inside its message handler
 * (which `disableStream`/`disableRange`/`disableAutoFetch` do NOT turn off —
 * those flags only govern network/data streaming, not worker IPC). Without
 * the polyfill, every getDocument() call fails with
 * `TypeError: undefined is not a function (near '...value of readableStream...')`.
 *
 * Spec-aligned implementation, lifted from the WHATWG Streams spec
 * (https://streams.spec.whatwg.org/#rs-asynciterator).
 */
function polyfillReadableStreamAsyncIterator(): void {
  if (typeof ReadableStream === "undefined") return;
  const proto = ReadableStream.prototype as unknown as Record<
    string | symbol,
    unknown
  >;
  if (proto[Symbol.asyncIterator]) return;
  const values = function (
    this: ReadableStream,
    options?: { preventCancel?: boolean },
  ) {
    const preventCancel = options?.preventCancel ?? false;
    const reader = this.getReader();
    return {
      next() {
        return reader.read().then(({ value, done }) => {
          if (done) reader.releaseLock();
          return { value, done };
        });
      },
      return(value: unknown) {
        if (!preventCancel) {
          const cancelPromise = reader.cancel(value);
          reader.releaseLock();
          return cancelPromise.then(() => ({ value, done: true }));
        }
        reader.releaseLock();
        return Promise.resolve({ value, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  proto["values"] = values;
  proto[Symbol.asyncIterator] = values;
}

export async function extractPdfLines(
  data: ArrayBuffer,
  password?: string,
): Promise<PdfLine[]> {
  polyfillReadableStreamAsyncIterator();

  // pdfjs-dist is heavy and only needed at parse-time. Dynamic import keeps
  // it out of the initial bundle and out of node-side test environments that
  // can't satisfy its browser globals (DOMMatrix, etc.).
  //
  // We use the `legacy` build because Tauri's WebKit on macOS is missing a
  // few features the modern build relies on; the legacy build targets older
  // runtimes and pairs with the legacy worker.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { default: workerUrl } = await import(
    "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"
  );
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  // PDF.js mutates the buffer it's given (it transfers ownership to the
  // worker). Pass a copy so callers can keep using the original.
  const bytes = new Uint8Array(data.slice(0));
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: bytes,
      password,
      // Tauri's WebKit on macOS lacks `ReadableStream[Symbol.asyncIterator]`,
      // which PDF.js v5 relies on for its default data-loading path. Since we
      // pass the whole buffer up front anyway, disabling streaming and range
      // fetching steers PDF.js onto the synchronous data-array code path and
      // avoids the async iterator entirely.
      disableStream: true,
      disableAutoFetch: true,
      disableRange: true,
    }).promise;
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "name" in e &&
      e.name === "PasswordException"
    ) {
      // PDF.js reason codes: 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD
      const code = (e as { code?: number }).code;
      if (code === 2) throw new PdfPasswordIncorrectError();
      throw new PdfPasswordRequiredError();
    }
    throw e;
  }

  const allLines: PdfLine[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const linesByY = new Map<number, PdfTextItem[]>();
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const str = item.str.trim();
      if (str === "") continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const key = Math.round(y);
      const arr = linesByY.get(key);
      const entry: PdfTextItem = { x, y, width: item.width, str };
      if (arr) arr.push(entry);
      else linesByY.set(key, [entry]);
    }
    // Descending y = top of page first.
    const sortedKeys = [...linesByY.keys()].sort((a, b) => b - a);
    for (const y of sortedKeys) {
      const items = linesByY.get(y)!.sort((a, b) => a.x - b.x);
      allLines.push({ page: pageNum, y, items });
    }
    page.cleanup();
  }
  await doc.cleanup();
  doc.destroy();
  return allLines;
}
