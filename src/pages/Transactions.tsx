import { useEffect, useState } from "react";

import { AccountChips } from "../components/AccountChips";
import { useT } from "../i18n";
import {
  Account,
  Transaction,
  listAccounts,
  listTransactions,
} from "../lib/api";

interface Props {
  selectedAccountIds: number[];
  onChangeSelectedAccountIds: (ids: number[]) => void;
  version: number;
}

export function TransactionsPage({
  selectedAccountIds,
  onChangeSelectedAccountIds,
  version,
}: Props) {
  const t = useT();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAccounts(), listTransactions(selectedAccountIds)])
      .then(([a, ts]) => {
        if (cancelled) return;
        setAccounts(a);
        setTxns(ts);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAccountIds, version]);

  const accountById = new Map(accounts.map((a) => [a.id, a]));

  return (
    <section className="page">
      <div className="tab-toolbar">
        <AccountChips
          accounts={accounts}
          selected={selectedAccountIds}
          onChange={onChangeSelectedAccountIds}
        />
      </div>

      {error && <div className="error">{error}</div>}

      <div className="txns-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("transactions.tableAccount")}</th>
              <th>{t("transactions.tableDate")}</th>
              <th>{t("transactions.tablePeer")}</th>
              <th className="num">{t("transactions.tableCredit")}</th>
              <th className="num">{t("transactions.tableDebit")}</th>
              <th className="num">{t("transactions.tableBalance")}</th>
              <th>{t("transactions.tableDescription")}</th>
            </tr>
          </thead>
          <tbody>
            {txns.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty">
                  {t("transactions.empty")}
                </td>
              </tr>
            ) : (
              txns.map((x) => {
                const acc = accountById.get(x.accountId);
                const accLabel = acc
                  ? `${acc.name || acc.accountNumber} · ${acc.currency}`
                  : `#${x.accountId}`;
                return (
                  <tr key={x.id}>
                    <td>{accLabel}</td>
                    <td>{formatInstant(x.occurredAtUtc)}</td>
                    <td>{x.peer}</td>
                    <td className="num">
                      {x.credit !== "0.00" ? x.credit : ""}
                    </td>
                    <td className="num">
                      {x.debit !== "0.00" ? x.debit : ""}
                    </td>
                    <td className="num">{x.balance}</td>
                    <td>{x.description}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 19).replace("T", " ");
}
