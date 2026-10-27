import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { DocumentModal } from "../../components/DocumentModal";
import { TransactionDocuments } from "../../components/TransactionDocuments";
import {
  Attachment,
  AttachmentLink,
  Transaction,
  attachmentFileUrl,
  listTransactionAttachments,
} from "../../lib/api";
import { formatMoney } from "../../lib/money";
import { useT } from "../../i18n";

interface Props {
  txn: Transaction;
  /** Documents linked to this transaction (empty when none). */
  links: AttachmentLink[];
  /** Local wall-time label of the transaction, for the dialog. */
  dateLabel: string;
  /** "Account name · currency", for the dialog header. */
  accountLabel: string;
  /** Persist the user's comment (empty string clears it). */
  onSaveComment: (comment: string) => Promise<void>;
  /** After documents were linked/unlinked/deleted. */
  onChanged: () => void;
}

function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

/** A small sticky note — the user's own comment. */
function StickerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 3h16v12l-6 6H4z" fill="#fde68a" stroke="#b45309" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M14 21v-6h6" fill="#fcd34d" stroke="#b45309" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 8h8M8 12h5" stroke="#b45309" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** The "Note" column — what the user knows about the transaction beyond the
 *  statement, in one line:
 *  - left, an icon: a sticker when the user wrote a comment (it wins: a
 *    hand-written note is worth more than a recognised slip, even when a slip
 *    is linked too), otherwise a paperclip when a document is linked (with a
 *    count for several), otherwise nothing (a green paperclip on hover);
 *  - right, the text: the comment, otherwise the note recognised on the slip.
 *  A click anywhere in the cell opens the "Document & comment" dialog — the
 *  cell itself is never edited in place. */
export function NoteCell({ txn, links, dateLabel, accountLabel, onSaveComment, onChanged }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const comment = txn.comment?.trim() ? txn.comment.trim() : null;
  const memo = links.find((l) => l.memo)?.memo ?? null;
  const text = comment ?? memo;
  const kind = comment ? "is-comment" : links.length > 0 ? "is-linked" : "is-startable";
  const title = [comment ? `🗒 ${comment}` : null, ...links.map((l) => `📎 ${l.originalName}${l.memo ? ` — ${l.memo}` : ""}`)]
    .filter(Boolean)
    .join("\n");

  return (
    <td className="col-note">
      <button
        type="button"
        className={`note-cell ${kind}`}
        title={title || t("transaction.documentAndComment")}
        aria-label={t("transaction.documentAndComment")}
        onClick={() => setOpen(true)}
      >
        <span className="note-cell-icon">
          {comment ? <StickerIcon /> : <PaperclipIcon />}
          {links.length > 1 && <span className="document-cell-count">{links.length}</span>}
        </span>
        {text && <span className="note-cell-text">{text}</span>}
      </button>
      {open && (
        <DocumentNoteModal
          txn={txn}
          dateLabel={dateLabel}
          accountLabel={accountLabel}
          onSaveComment={onSaveComment}
          onChanged={onChanged}
          onClose={() => setOpen(false)}
        />
      )}
    </td>
  );
}

/** "Document & comment" dialog: the linked slip (preview), the transaction's
 *  facts, the user's own comment and the document picker. */
function DocumentNoteModal({
  txn,
  dateLabel,
  accountLabel,
  onSaveComment,
  onChanged,
  onClose,
}: {
  txn: Transaction;
  dateLabel: string;
  accountLabel: string;
  onSaveComment: (comment: string) => Promise<void>;
  onChanged: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [docs, setDocs] = useState<Attachment[] | null>(null);
  const [version, setVersion] = useState(0);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [pickerViewerOpen, setPickerViewerOpen] = useState(false);
  const [comment, setComment] = useState(txn.comment ?? "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const savedRef = useRef((txn.comment ?? "").trim());
  const incoming = txn.credit !== "0.00";

  useEffect(() => {
    let cancelled = false;
    listTransactionAttachments(txn.id)
      .then((d) => !cancelled && setDocs(d))
      .catch(() => !cancelled && setDocs([]));
    return () => {
      cancelled = true;
    };
  }, [txn.id, version]);

  // Saved on blur, Ctrl/⌘+Enter and when the dialog closes.
  const saveComment = useCallback(async () => {
    const next = comment.trim();
    if (next === savedRef.current) return;
    setSaveState("saving");
    try {
      await onSaveComment(next);
      savedRef.current = next;
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }, [comment, onSaveComment]);

  const close = useCallback(() => {
    void saveComment();
    onClose();
  }, [saveComment, onClose]);

  const nestedOpen = viewing !== null || pickerViewerOpen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !nestedOpen && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, nestedOpen]);

  const changed = () => {
    setVersion((v) => v + 1);
    onChanged();
  };
  const preview = docs?.find((d) => d.mimeType.startsWith("image/")) ?? null;

  return (
    <>
      {createPortal(
        <div className="modal-backdrop" onClick={close}>
          <div
            className={`modal modal--link-doc${preview ? " modal--link-doc-wide" : ""}`}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <div className="txn-modal-title">
                <h3>{t("transaction.documentAndComment")}</h3>
                <span className="txn-modal-subtitle">{accountLabel}</span>
              </div>
              <button className="icon-btn" onClick={close} aria-label={t("common.close")} type="button">
                ×
              </button>
            </header>
            <div className="modal-body link-doc-body">
              {preview && (
                <button
                  type="button"
                  className="link-doc-preview"
                  title={t("transactions.openDocument")}
                  onClick={() => setViewing(preview)}
                >
                  <img src={attachmentFileUrl(preview.id)} alt={preview.originalName} />
                </button>
              )}
              <div className="link-doc-main">
                <div className="txn-readonly-grid">
                  <div className="txn-readonly">
                    <span className="txn-field-label">{t("transaction.fieldDate")}</span>
                    <span title={txn.occurredAtUtc}>{dateLabel}</span>
                  </div>
                  <div className="txn-readonly">
                    <span className="txn-field-label">{t("transaction.fieldCredit")}</span>
                    <span className="amount-credit">{incoming ? formatMoney(txn.credit) : "—"}</span>
                  </div>
                  <div className="txn-readonly">
                    <span className="txn-field-label">{t("transaction.fieldDebit")}</span>
                    <span className="amount-debit">{incoming ? "—" : formatMoney(txn.debit)}</span>
                  </div>
                  <div className="txn-readonly">
                    <span className="txn-field-label">{t("transaction.fieldBalance")}</span>
                    <span>{formatMoney(txn.balance)}</span>
                  </div>
                </div>
                <dl className="document-fields link-doc-facts">
                  {[
                    [t("transaction.fieldPeer"), txn.peer],
                    [t("transaction.fieldDescription"), txn.bankDescription],
                  ].map(([label, value]) => (
                    <div key={label} className="document-field">
                      <dt>{label}</dt>
                      <dd>{value || <span className="hint">—</span>}</dd>
                    </div>
                  ))}
                </dl>

                <label className="txn-field">
                  <span className="txn-field-label">
                    {t("transaction.fieldComment")}
                    <span className="link-doc-save-state">
                      {saveState === "saving" && t("common.saving")}
                      {saveState === "saved" && t("transaction.commentSaved")}
                      {saveState === "error" && t("transaction.commentSaveFailed")}
                    </span>
                  </span>
                  <textarea
                    rows={2}
                    value={comment}
                    placeholder={t("transaction.commentHint")}
                    onChange={(e) => {
                      setComment(e.target.value);
                      setSaveState("idle");
                    }}
                    onBlur={() => void saveComment()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void saveComment();
                    }}
                  />
                </label>

                {docs !== null && (
                  <TransactionDocuments
                    transactionId={txn.id}
                    initialPicking={docs.length === 0}
                    onViewerToggle={setPickerViewerOpen}
                    onChanged={changed}
                  />
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body,
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
    </>
  );
}
