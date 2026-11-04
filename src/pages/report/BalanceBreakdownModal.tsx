import { createPortal } from "react-dom";

import { useT } from "../../i18n";
import { AccountBalances } from "../../lib/api";
import { formatMinorAsMoney, formatMoney } from "../../lib/money";
import { BalanceMetric, balanceBreakdown } from "../../lib/report-balances";

interface Props {
  metric: BalanceMetric;
  metricLabel: string;
  periodLabel: string;
  periodIndex: number;
  byAccount: AccountBalances[];
  /** Accounts in the owner's order. */
  accounts: { id: number; currency: string; label: string }[];
  onClose: () => void;
}

/// Report → a click on an opening or closing balance: which accounts the number
/// is made of, and how fresh each of them is.
export function BalanceBreakdownModal({
  metric,
  metricLabel,
  periodLabel,
  periodIndex,
  byAccount,
  accounts,
  onClose,
}: Props) {
  const t = useT();
  const { rows, totalMinor } = balanceBreakdown(byAccount, metric, periodIndex, accounts.map((a) => a.id));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const currencies = new Set(rows.map((r) => byId.get(r.accountId)?.currency));

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal balance-breakdown-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>
            {metricLabel} · {periodLabel}
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")} type="button">
            ×
          </button>
        </header>
        <div className="modal-body">
          <p className="hint">{t(`report.balanceBreakdown.hint.${metric}`)}</p>
          <table className="cell-txns-table balance-breakdown-table">
            <thead>
              <tr>
                <th>{t("report.cellTxns.colAccount")}</th>
                <th className="balance-breakdown-amount">{t("report.balanceBreakdown.colBalance")}</th>
                <th>{t("report.balanceBreakdown.colAsOf")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.accountId}>
                  <td>{byId.get(r.accountId)?.label ?? `#${r.accountId}`}</td>
                  <td className="balance-breakdown-amount">{formatMoney(r.amount)}</td>
                  <td>{r.asOf ?? t("report.balanceBreakdown.noTxns")}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>{t("report.cellTxns.total")}</td>
                <td className="balance-breakdown-amount">{formatMoney(formatMinorAsMoney(totalMinor))}</td>
                <td />
              </tr>
            </tfoot>
          </table>
          {currencies.size > 1 && <p className="hint">{t("report.balanceBreakdown.mixedCurrencies")}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
