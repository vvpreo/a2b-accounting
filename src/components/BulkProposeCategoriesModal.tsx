import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import { AiProviderConfig, Transaction, loadAiConfig, parseAgentState } from "../lib/api";
import { runAgentAnalysis } from "../lib/agent-run";

interface Props {
  /// The selected, currently-visible transactions.
  transactions: Transaction[];
  onClose: () => void;
  /// After the run, so the table reloads the agent verdicts.
  onDone: () => void;
}

type Phase = "confirm" | "running" | "done";

/// Errors that would repeat on every row (missing key, provider down) — stop
/// at the first one instead of failing the whole selection.
function isFatal(error: string): boolean {
  return /environment variable|not configured|base url|model is not set|401|403/i.test(error);
}

/// Bulk "Propose categories": run the categorisation agent on each selected
/// transaction and store its suggestion (shown in the AI column). Nothing is
/// applied — the user reviews and applies.
export function BulkProposeCategoriesModal({ transactions, onClose, onDone }: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("confirm");
  const [config, setConfig] = useState<AiProviderConfig | null>(null);
  const [redo, setRedo] = useState(false);
  const [done, setDone] = useState(0);
  const [proposed, setProposed] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const stopRef = useRef(false);

  useEffect(() => {
    loadAiConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  const alreadyAnalysed = transactions.filter(
    (x) => (parseAgentState(x.agent)?.messages.length ?? 0) > 0,
  );
  const targets = redo
    ? transactions
    : transactions.filter((x) => !alreadyAnalysed.includes(x));

  async function run() {
    setPhase("running");
    stopRef.current = false;
    const queue = [...targets];
    async function worker() {
      while (queue.length > 0 && !stopRef.current) {
        const txn = queue.shift()!;
        try {
          await runAgentAnalysis(txn.id);
          setProposed((n) => n + 1);
        } catch (e) {
          const msg = String(e);
          setErrors((list) => (list.length < 20 ? [...list, msg] : list));
          if (isFatal(msg)) stopRef.current = true;
        }
        setDone((n) => n + 1);
      }
    }
    await Promise.all([worker(), worker()]);
    setPhase("done");
  }

  function close() {
    if (phase === "running") return;
    if (phase === "done") onDone();
    onClose();
  }

  let provider = t("transactions.bulkPropose.providerUnknown");
  if (config) {
    try {
      provider = `${new URL(config.baseUrl).host} · ${config.model}`;
    } catch {
      provider = `${config.baseUrl} · ${config.model}`;
    }
  }

  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal modal--bulk-docs" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{t("transactions.bulkPropose.title")}</h3>
          {phase !== "running" && (
            <button className="icon-btn" onClick={close} aria-label={t("common.close")} type="button">
              ×
            </button>
          )}
        </header>
        <div className="modal-body">
          {phase === "confirm" ? (
            <>
              <p>{t("transactions.bulkPropose.intro", { count: targets.length })}</p>
              <p className="hint">{t("transactions.bulkPropose.provider", { provider })}</p>
              {alreadyAnalysed.length > 0 && (
                <label className="checkbox-row">
                  <input type="checkbox" checked={redo} onChange={(e) => setRedo(e.target.checked)} />
                  <span>{t("transactions.bulkPropose.redo", { count: alreadyAnalysed.length })}</span>
                </label>
              )}
            </>
          ) : (
            <>
              <div className="documents-progress">
                <div>{t("transactions.bulkDocs.progress", { done, count: targets.length })}</div>
                <progress value={done} max={targets.length || 1} />
              </div>
              <p>{t("transactions.bulkPropose.result", { proposed, failed: errors.length })}</p>
              {errors.length > 0 && (
                <details open={stopRef.current}>
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
              <button type="button" className="btn-primary" onClick={run} disabled={targets.length === 0}>
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
