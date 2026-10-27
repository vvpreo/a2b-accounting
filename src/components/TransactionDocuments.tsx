import { useEffect, useState } from "react";

import { useI18n, useT } from "../i18n";
import {
  Attachment,
  AttachmentCandidates,
  attachmentFileUrl,
  linkAttachment,
  listAttachmentCandidates,
  listTransactionAttachments,
  unlinkAttachment,
} from "../lib/api";
import { baseName, DocumentModal, formatDocTime, parseExtraction } from "./DocumentModal";

/** Time windows offered when picking a document by eye, in minutes. */
const WINDOWS = [5, 30, 24 * 60];

/** "+55 s", "−2 min 10 s", "+3 h 5 min" — document time relative to the
 *  transaction. */
function formatDelta(seconds: number, t: ReturnType<typeof useT>): string {
  const sign = seconds < 0 ? "−" : "+";
  let rest = Math.abs(seconds);
  const h = Math.floor(rest / 3600);
  rest -= h * 3600;
  const m = Math.floor(rest / 60);
  const s = rest - m * 60;
  const parts: string[] = [];
  if (h) parts.push(t("documents.deltaH", { n: h }));
  if (m) parts.push(t("documents.deltaM", { n: m }));
  if (!h && (s || !m)) parts.push(t("documents.deltaS", { n: s }));
  return sign + parts.join(" ");
}

function Thumb({ doc }: { doc: Attachment }) {
  return doc.mimeType.startsWith("image/") ? (
    <img className="txn-doc-thumb" src={attachmentFileUrl(doc.id)} alt="" loading="lazy" />
  ) : (
    <span className="txn-doc-thumb txn-doc-thumb--pdf">PDF</span>
  );
}

/**
 * "Document" block of the transaction modal: the linked document(s), and a
 * picker that lists documents whose time is within a window around the
 * transaction so the user can link the right slip by eye.
 */
export function TransactionDocuments({
  transactionId,
  onChanged,
  onViewerToggle,
  initialPicking = false,
}: {
  transactionId: number;
  onChanged?: () => void;
  /** Open with the time-window picker already expanded. */
  initialPicking?: boolean;
  /** Tells the host modal a nested document viewer is open (so ESC closes
   *  only the viewer). */
  onViewerToggle?: (open: boolean) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [linked, setLinked] = useState<Attachment[]>([]);
  const [picking, setPicking] = useState(initialPicking);
  const [windowMinutes, setWindowMinutes] = useState(WINDOWS[0]);
  const [found, setFound] = useState<AttachmentCandidates | null>(null);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listTransactionAttachments(transactionId)
      .then((docs) => !cancelled && setLinked(docs))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [transactionId, version]);

  useEffect(() => {
    if (!picking) return;
    let cancelled = false;
    setFound(null);
    listAttachmentCandidates(transactionId, windowMinutes)
      .then((c) => !cancelled && setFound(c))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [picking, transactionId, windowMinutes, version]);

  useEffect(() => {
    onViewerToggle?.(viewing !== null);
  }, [viewing, onViewerToggle]);

  const changed = () => {
    setVersion((v) => v + 1);
    onChanged?.();
  };

  async function act(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
      changed();
    } catch (e) {
      setError(String(e));
    }
  }

  const docTime = (doc: Attachment) => {
    const value = parseExtraction(doc.extraction)?.occurredAt?.value;
    return value ? formatDocTime(value, locale) : null;
  };

  return (
    <div className="txn-docs">
      <div className="txn-cats-header">
        <span className="txn-field-label">{t("transaction.documents")}</span>
        <button
          type="button"
          className="btn-ghost btn-small"
          onClick={() => setPicking((v) => !v)}
        >
          {picking ? t("transaction.hideDocumentPicker") : t("transaction.linkDocument")}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {linked.length === 0 ? (
        !picking && <p className="hint">{t("transaction.noDocuments")}</p>
      ) : (
        <ul className="txn-doc-list">
          {linked.map((doc) => (
            <li key={doc.id} className="txn-doc">
              <button type="button" className="txn-doc-open" onClick={() => setViewing(doc)}>
                <Thumb doc={doc} />
                <span className="txn-doc-name">{baseName(doc.originalName)}</span>
                {docTime(doc) && <span className="hint">{docTime(doc)}</span>}
                {parseExtraction(doc.extraction)?.memo?.value && (
                  <span className="txn-doc-memo">
                    {parseExtraction(doc.extraction)?.memo?.value}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="btn-ghost btn-small"
                onClick={() => act(() => unlinkAttachment(doc.id))}
              >
                {t("documents.unlink")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {picking && (
        <div className="txn-doc-picker">
          <div className="txn-doc-picker-head">
            <span>{t("transaction.documentWindow")}</span>
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                className={`documents-filter${w === windowMinutes ? " active" : ""}`}
                onClick={() => setWindowMinutes(w)}
              >
                {t(`transaction.window.${w}`)}
              </button>
            ))}
          </div>
          {!found ? (
            <p className="hint">{t("common.loading")}</p>
          ) : (
            <>
              {found.candidates.length === 0 && (
                <p className="hint">{t("transaction.noCandidates")}</p>
              )}
              <ul className="txn-doc-list">
                {found.candidates.map(({ attachment: doc, deltaSeconds }) => {
                  const here = doc.transactionId === transactionId;
                  const elsewhere = doc.transactionId !== null && !here;
                  return (
                    <li key={doc.id} className="txn-doc">
                      <button
                        type="button"
                        className="txn-doc-open"
                        onClick={() => setViewing(doc)}
                      >
                        <Thumb doc={doc} />
                        <span className="txn-doc-delta">{formatDelta(deltaSeconds, t)}</span>
                        <span className="txn-doc-name">{baseName(doc.originalName)}</span>
                        <span className="hint">{docTime(doc)}</span>
                        {elsewhere && (
                          <span className="txn-doc-badge">{t("transaction.linkedElsewhere")}</span>
                        )}
                      </button>
                      {here ? (
                        <span className="hint">{t("transaction.alreadyLinked")}</span>
                      ) : (
                        <button
                          type="button"
                          className="btn-primary btn-small"
                          onClick={() => act(() => linkAttachment(doc.id, transactionId))}
                        >
                          {t("transaction.link")}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {found.undatedCount > 0 && (
                <p className="hint">
                  {t("transaction.undatedDocuments", { count: found.undatedCount })}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {viewing && (
        <DocumentModal
          doc={viewing}
          onClose={() => setViewing(null)}
          onDeleted={() => {
            setViewing(null);
            changed();
          }}
          onChanged={() => {
            setViewing(null);
            changed();
          }}
        />
      )}
    </div>
  );
}
