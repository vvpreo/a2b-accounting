import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n, useT } from "../i18n";
import {
  Attachment,
  attachmentFileUrl,
  deleteAttachment,
  recogniseDocument,
  unlinkAttachment,
} from "../lib/api";

/** One recognised field: the value plus which extractor produced it
 *  (`qr`, `filename`, `ocr`, …) — shown so the user can judge trust. */
export interface ExtractedField {
  value: string;
  source?: string;
}

/** Shape of `attachments.extraction`. Every field is optional: each one is
 *  produced by an independent extractor and any of them may come up empty. */
export interface Extraction {
  bank?: ExtractedField;
  account?: ExtractedField;
  occurredAt?: ExtractedField;
  amount?: ExtractedField;
  direction?: ExtractedField;
  memo?: ExtractedField;
  reference?: ExtractedField;
}

const EXTRACTION_FIELDS: (keyof Extraction)[] = [
  "memo",
  "occurredAt",
  "amount",
  "direction",
  "account",
  "bank",
  "reference",
];

export function parseExtraction(raw: string | null): Extraction | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Extraction) : null;
  } catch {
    return null;
  }
}

/** Display a document time. Zone-less values are the wall time printed on the
 *  slip and are shown as-is; `…Z` values are instants shown in local time. */
export function formatDocTime(value: string, locale: string): string {
  // `Date` parses a zone-less ISO string as local time — exactly the
  // "as printed" reading we want; a `Z` instant is converted to local time.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "medium" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Base name of a ZIP entry path (`vvpreo/KSK/a.jpeg` → `a.jpeg`). */
export function baseName(path: string): string {
  return path.split("/").pop() || path;
}

/** Full-screen document viewer: the file itself plus the recognition result,
 *  file facts, link state and delete. Used by the Documents page and by the
 *  Transactions screen. */
export function DocumentModal(props: {
  doc: Attachment;
  onClose: () => void;
  onDeleted: () => void;
  /** After unlinking from its transaction or re-recognising. */
  onChanged: () => void;
  /** Opened from a transaction's document picker: link the document to that
   *  transaction right here (the host closes the viewer afterwards). */
  onLink?: () => Promise<void>;
}) {
  const t = useT();
  const { locale } = useI18n();
  const { doc } = props;
  const extraction = parseExtraction(doc.extraction);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = attachmentFileUrl(doc.id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  async function run(action: () => Promise<void>, after: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      after();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const fieldValue = (key: keyof Extraction): string | null => {
    const value = extraction?.[key]?.value;
    if (!value) return null;
    if (key === "occurredAt") return formatDocTime(value, locale);
    if (key === "direction") return t(`documents.direction.${value}`);
    return value;
  };

  return createPortal(
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3 title={doc.originalName}>{baseName(doc.originalName)}</h3>
          <button
            className="icon-btn"
            onClick={props.onClose}
            aria-label={t("common.close")}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="modal-body document-view">
          <div className="document-view-file">
            {doc.mimeType === "application/pdf" ? (
              <iframe src={url} title={doc.originalName} />
            ) : (
              <a href={url} target="_blank" rel="noreferrer">
                <img src={url} alt={doc.originalName} />
              </a>
            )}
          </div>
          <div className="document-view-info">
            <h4>{t("documents.resultTitle")}</h4>
            <div className="document-link-state">
              <span className={`documents-status documents-status--${doc.extractStatus}`}>
                {t(`documents.extractStatus.${doc.extractStatus}`)}
              </span>
              <button
                type="button"
                className="btn-ghost btn-small"
                disabled={busy}
                onClick={() => run(() => recogniseDocument(doc.id), props.onChanged)}
              >
                {busy ? t("documents.recognising") : t("documents.recognise")}
              </button>
            </div>
            <dl className="document-fields">
              {EXTRACTION_FIELDS.map((key) => {
                const field = extraction?.[key];
                const value = fieldValue(key);
                return (
                  <div key={key} className="document-field">
                    <dt>{t(`documents.field.${key}`)}</dt>
                    <dd>
                      {value ?? <span className="hint">—</span>}
                      {field?.source && (
                        <span className="document-field-source">
                          {t("documents.fieldSource", {
                            source: t(`documents.source.${field.source}`),
                          })}
                        </span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
            {doc.extractStatus === "pending" && (
              <p className="hint">{t("documents.notRecognisedYet")}</p>
            )}
            {doc.ocrText && (
              <details>
                <summary>{t("documents.ocrText")}</summary>
                <pre className="document-ocr">{doc.ocrText}</pre>
              </details>
            )}

            <h4>{t("documents.linkTitle")}</h4>
            {doc.transactionId !== null ? (
              <div className="document-link-state">
                <span>{t(`documents.matchStatus.${doc.matchStatus}`)}</span>
                <button
                  type="button"
                  className="btn-ghost btn-small"
                  disabled={busy}
                  onClick={() => run(() => unlinkAttachment(doc.id), props.onChanged)}
                >
                  {t("documents.unlink")}
                </button>
              </div>
            ) : (
              <p className="hint">{props.onLink ? t("documents.linkHereHint") : t("documents.notLinkedHint")}</p>
            )}

            <h4>{t("documents.fileTitle")}</h4>
            <dl className="document-fields">
              <div className="document-field">
                <dt>{t("documents.fileName")}</dt>
                <dd className="document-break">{doc.originalName}</dd>
              </div>
              <div className="document-field">
                <dt>{t("documents.fileType")}</dt>
                <dd>
                  {doc.mimeType} · {formatBytes(doc.sizeBytes)}
                </dd>
              </div>
              <div className="document-field">
                <dt>{t("documents.fileUploaded")}</dt>
                <dd>
                  {new Date(doc.uploadedAt).toLocaleString(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </dd>
              </div>
            </dl>

            {error && <div className="error">{error}</div>}
            {confirmingDelete && (
              <div className="danger-confirm">
                <p>{t("documents.deleteConfirm")}</p>
                <div className="danger-confirm-actions">
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => run(() => deleteAttachment(doc.id), props.onDeleted)}
                    disabled={busy}
                  >
                    {busy ? t("common.deleting") : t("common.delete")}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={busy}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <footer className="modal-footer">
          <button
            type="button"
            className="btn-danger-ghost modal-footer-left"
            onClick={() => setConfirmingDelete(true)}
            disabled={confirmingDelete || busy}
          >
            {t("documents.delete")}
          </button>
          <a className="btn-ghost" href={url} target="_blank" rel="noreferrer">
            {t("documents.openOriginal")}
          </a>
          {props.onLink ? (
            <>
              <button type="button" className="btn-secondary" onClick={props.onClose}>
                {t("common.close")}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => run(props.onLink!, () => {})}
              >
                {t("transaction.link")}
              </button>
            </>
          ) : (
            <button type="button" className="btn-primary" onClick={props.onClose}>
              {t("common.close")}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
