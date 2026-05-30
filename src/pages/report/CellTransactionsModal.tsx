import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import {
  CellTransaction,
  ReportRequest,
  reportCellTransactions,
} from "../../lib/api";
import { formatMinorAsMoney } from "../../lib/money";
import type { CellClickInfo } from "../ReportView";

interface CellTransactionsModalProps {
  request: ReportRequest;
  info: CellClickInfo;
  // id → display label for the account column.
  accountNameById: Map<number, string>;
  onClose: () => void;
}

// Render an ISO instant as local "YYYY-MM-DD HH:MM" — same shape as the
// Transactions tab, so dates read identically across screens.
function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${mi}`;
}

/**
 * View-only drill-down for a single report cell. Fetches the transactions that
 * rolled into the clicked cell (same scope/exclusion/attribution as the report)
 * and lists them with the share attributed to this category. The footer total
 * equals the clicked cell value.
 */
export function CellTransactionsModal({
  request,
  info,
  accountNameById,
  onClose,
}: CellTransactionsModalProps) {
  const { t } = useI18n();
  const [rows, setRows] = useState<CellTransaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ESC closes the modal.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    reportCellTransactions(request, info.target)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [request, info]);

  const total = useMemo(
    () => (rows ? rows.reduce((acc, r) => acc + r.shareMinor, 0) : 0),
    [rows],
  );

  const sectionLabel =
    info.sectionKind === "income"
      ? t("report.sectionIncome")
      : t("report.sectionExpense");

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal cell-txns-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <div className="cell-txns-title">
            <h3>
              {info.categoryLabel} · {info.periodLabel}
            </h3>
            <span className="cell-txns-subtitle">{sectionLabel}</span>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
            type="button"
          >
            ×
          </button>
        </header>

        <div className="modal-body cell-txns-body">
          {error && <div className="error">{error}</div>}
          {!error && rows === null && (
            <div className="report-loading">{t("report.loading")}</div>
          )}
          {!error && rows !== null && rows.length === 0 && (
            <div className="cell-txns-empty">
              {t("report.cellTxns.empty")}
            </div>
          )}
          {!error && rows !== null && rows.length > 0 && (
            <table className="cell-txns-table">
              <thead>
                <tr>
                  <th>{t("report.cellTxns.colDate")}</th>
                  <th>{t("report.cellTxns.colAccount")}</th>
                  <th className="cell-txns-amount">
                    {t("report.cellTxns.colAmount")}
                  </th>
                  <th>{t("report.cellTxns.colPeer")}</th>
                  <th>{t("report.cellTxns.colDescription")}</th>
                  <th>{t("report.cellTxns.colComment")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="cell-txns-date">{formatLocal(r.occurredAtUtc)}</td>
                    <td className="cell-txns-ellipsis" title={accountNameById.get(r.accountId) ?? ""}>
                      {accountNameById.get(r.accountId) ?? `#${r.accountId}`}
                    </td>
                    <td className="cell-txns-amount">
                      {formatMinorAsMoney(r.shareMinor)}
                    </td>
                    <td className="cell-txns-ellipsis" title={r.peer ?? ""}>
                      {r.peer ?? ""}
                    </td>
                    <td
                      className="cell-txns-ellipsis"
                      title={r.bankDescription ?? ""}
                    >
                      {r.bankDescription ?? ""}
                    </td>
                    <td className="cell-txns-ellipsis" title={r.comment ?? ""}>
                      {r.comment ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <footer className="modal-footer cell-txns-footer">
          <span className="cell-txns-total">
            {t("report.cellTxns.total")}: {formatMinorAsMoney(total)}
          </span>
          <button type="button" className="btn-primary" onClick={onClose}>
            {t("common.close")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
