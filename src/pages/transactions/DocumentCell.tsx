import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { DocumentModal } from "../../components/DocumentModal";
import { TransactionDocuments } from "../../components/TransactionDocuments";
import {
  Attachment,
  AttachmentLink,
  Transaction,
  listTransactionAttachments,
} from "../../lib/api";
import { formatMoney } from "../../lib/money";
import { useT } from "../../i18n";

interface Props {
  txn: Transaction;
  /** Documents linked to this transaction (empty when none). */
  links: AttachmentLink[];
  /** Local wall-time label of the transaction, for the picker header. */
  dateLabel: string;
  /** "Account name · currency", for the picker header. */
  accountLabel: string;
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

/** Narrow "document" column, by analogy with the 🔗 transfer-link column:
 *  - linked: a blue paperclip (with a count for several) — click opens the
 *    document;
 *  - not linked: an invisible paperclip that turns green on hover — click
 *    opens the document picker for this transaction straight away. */
export function DocumentCell({ txn, links, dateLabel, accountLabel, onChanged }: Props) {
  const t = useT();
  const [doc, setDoc] = useState<Attachment | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linked = links.length > 0;

  async function openDocument() {
    setError(null);
    try {
      const docs = await listTransactionAttachments(txn.id);
      if (docs.length > 0) setDoc(docs[0]);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <td className="col-document">
      <button
        type="button"
        className={`document-cell-btn ${linked ? "is-linked" : "is-startable"}`}
        title={
          error ??
          (linked ? links.map((l) => l.originalName).join("\n") : t("transaction.linkDocument"))
        }
        aria-label={linked ? t("transactions.openDocument") : t("transaction.linkDocument")}
        onClick={() => (linked ? void openDocument() : setPicking(true))}
      >
        <PaperclipIcon />
        {links.length > 1 && <span className="document-cell-count">{links.length}</span>}
      </button>
      {doc && (
        <DocumentModal
          doc={doc}
          onClose={() => setDoc(null)}
          onDeleted={() => {
            setDoc(null);
            onChanged();
          }}
          onChanged={() => {
            setDoc(null);
            onChanged();
          }}
        />
      )}
      {picking && (
        <LinkDocumentModal
          txn={txn}
          dateLabel={dateLabel}
          accountLabel={accountLabel}
          onClose={() => {
            setPicking(false);
            onChanged();
          }}
        />
      )}
    </td>
  );
}

/** Quick-link dialog opened from the 📎 column: the transaction's main facts
 *  (as in the transaction modal, read-only) and the time-window document
 *  picker. */
function LinkDocumentModal({
  txn,
  dateLabel,
  accountLabel,
  onClose,
}: {
  txn: Transaction;
  dateLabel: string;
  accountLabel: string;
  onClose: () => void;
}) {
  const t = useT();
  const [viewerOpen, setViewerOpen] = useState(false);
  const incoming = txn.credit !== "0.00";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !viewerOpen && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, viewerOpen]);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--link-doc" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <div className="txn-modal-title">
            <h3>{t("transaction.linkDocument")}</h3>
            <span className="txn-modal-subtitle">{accountLabel}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")} type="button">
            ×
          </button>
        </header>
        <div className="modal-body">
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
              [t("transaction.fieldComment"), txn.comment],
            ].map(([label, value]) => (
              <div key={label} className="document-field">
                <dt>{label}</dt>
                <dd>{value || <span className="hint">—</span>}</dd>
              </div>
            ))}
          </dl>
          <TransactionDocuments
            transactionId={txn.id}
            initialPicking
            onViewerToggle={setViewerOpen}
            // Picking a document is the whole point of this dialog — close
            // it as soon as the link is made.
            onChanged={onClose}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
