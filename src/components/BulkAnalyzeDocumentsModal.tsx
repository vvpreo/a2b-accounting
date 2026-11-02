import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import {
  DocumentAnalysisStatus,
  Transaction,
  analyzeTransactionDocuments,
} from "../lib/api";

interface Props {
  /// The selected, currently-visible transactions.
  transactions: Transaction[];
  onClose: () => void;
  /// After the run, so the table can reload document links / memos.
  onDone: () => void;
}

type Phase = "confirm" | "running" | "done";
type Outcome = DocumentAnalysisStatus | "error";

const OUTCOMES: Outcome[] = [
  "auto_linked",
  "linked",
  "ambiguous",
  "no_match",
  "no_candidates",
  "error",
];

/// Two transactions at a time: OCR is CPU-bound on the server, and this keeps
/// the run quick without starving other requests.
const CONCURRENCY = 2;

/// Bulk "analyze documents" over the selected transactions: for each one,
/// recognise its linked document or find and auto-link one, extracting the
/// memo. Everything runs locally on the server.
export function BulkAnalyzeDocumentsModal({ transactions, onClose, onDone }: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("confirm");
  const [done, setDone] = useState(0);
  const [counts, setCounts] = useState<Record<Outcome, number>>(
    () => Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>,
  );
  const [errors, setErrors] = useState<string[]>([]);
  const stopRef = useRef(false);

  async function run() {
    setPhase("running");
    stopRef.current = false;
    const queue = [...transactions];
    const bump = (o: Outcome) => setCounts((c) => ({ ...c, [o]: c[o] + 1 }));
    async function worker() {
      while (queue.length > 0 && !stopRef.current) {
        const txn = queue.shift()!;
        try {
          const r = await analyzeTransactionDocuments(txn.id);
          bump(r.status);
        } catch (e) {
          bump("error");
          setErrors((list) => (list.length < 20 ? [...list, String(e)] : list));
          // No OCR on the server — every other row would fail the same way.
          if (String(e).startsWith("ocr.unavailable")) stopRef.current = true;
        }
        setDone((n) => n + 1);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setPhase("done");
  }

  function close() {
    if (phase === "running") return;
    if (phase === "done") onDone();
    onClose();
  }

  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal modal--bulk-docs" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{t("transactions.bulkDocs.title")}</h3>
          {phase !== "running" && (
            <button className="icon-btn" onClick={close} aria-label={t("common.close")} type="button">
              ×
            </button>
          )}
        </header>
        <div className="modal-body">
          {phase === "confirm" ? (
            <>
              <p>{t("transactions.bulkDocs.intro", { count: transactions.length })}</p>
              <p className="hint">{t("transactions.bulkDocs.local")}</p>
            </>
          ) : (
            <>
              <div className="documents-progress">
                <div>
                  {t("transactions.bulkDocs.progress", { done, count: transactions.length })}
                </div>
                <progress value={done} max={transactions.length || 1} />
              </div>
              <dl className="document-fields">
                {OUTCOMES.filter((o) => o !== "error" || counts.error > 0).map((o) => (
                  <div key={o} className="document-field">
                    <dt>{t(`transactions.bulkDocs.outcome.${o}`)}</dt>
                    <dd>{counts[o]}</dd>
                  </div>
                ))}
              </dl>
              {errors.length > 0 && (
                <details>
                  <summary>{t("transactions.bulkDocs.errors")}</summary>
                  <ul>
                    {errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
        <footer className="modal-footer">
          {phase === "confirm" && (
            <>
              <button type="button" className="btn-ghost" onClick={close}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={run}
                disabled={transactions.length === 0}
              >
                {t("transactions.bulkDocs.start")}
              </button>
            </>
          )}
          {phase === "running" && (
            <button type="button" className="btn-ghost" onClick={() => (stopRef.current = true)}>
              {t("transactions.bulkDocs.stop")}
            </button>
          )}
          {phase === "done" && (
            <button type="button" className="btn-primary" onClick={close}>
              {t("common.close")}
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
