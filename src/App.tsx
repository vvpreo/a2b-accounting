import { useEffect, useState } from "react";

import "./App.css";
import { Tab, Tabs } from "./components/Tabs";
import { listReportViews, listTransactions, ReportView } from "./lib/api";
import { AccountsPage, CreateAccountModal } from "./pages/Accounts";
import { CategoriesPage } from "./pages/Categories";
import { ImportDialog } from "./pages/ImportDialog";
import { ReportViewPage } from "./pages/ReportView";
import { SettingsPage } from "./pages/Settings";
import { TransactionsPage } from "./pages/Transactions";

function App() {
  // On startup we land on Transactions if any exist, otherwise Accounts. We
  // hold off rendering the page area until that check resolves so the user
  // doesn't see a brief flash of the wrong tab.
  const [tab, setTab] = useState<Tab | null>(null);
  const [txnFilterAccountIds, setTxnFilterAccountIds] = useState<number[]>([]);
  // One-shot navigation hint emitted when the user clicks a month cell on
  // the Accounts tab: TransactionsPage consumes it on mount/update to apply
  // the date range, then calls back to clear it so subsequent navigations
  // (or manual filter changes) aren't overwritten by the same hint twice.
  const [txnPendingMonth, setTxnPendingMonth] = useState<{
    accountId: number;
    yearMonth: string;
  } | null>(null);
  const [creatingAccount, setCreatingAccount] = useState(false);
  // null = import dialog closed. Otherwise the dialog is open, optionally with
  // an account preselected: `accountId` is set when opened from the Accounts
  // tab's per-row Import button, and null when opened from the Transactions
  // toolbar (the user picks the account inside the dialog).
  const [importState, setImportState] = useState<{
    accountId: number | null;
  } | null>(null);
  const [accountsVersion, setAccountsVersion] = useState(0);

  function openAccountMonthInTransactions(accountId: number, yearMonth: string) {
    setTxnFilterAccountIds([accountId]);
    setTxnPendingMonth({ accountId, yearMonth });
    setTab("transactions");
  }

  const [reportViews, setReportViews] = useState<ReportView[]>([]);
  const [reportViewsVersion, setReportViewsVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listTransactions(undefined)
      .then((txns) => {
        if (!cancelled) setTab(txns.length > 0 ? "transactions" : "accounts");
      })
      .catch(() => {
        if (!cancelled) setTab("accounts");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    listReportViews()
      .then(setReportViews)
      .catch(() => setReportViews([]));
  }, [reportViewsVersion]);

  // If the active tab points at a report view that no longer exists, fall back
  // to Accounts so the UI never shows a dangling page.
  useEffect(() => {
    if (tab && typeof tab !== "string" && tab.kind === "report") {
      const stillExists = reportViews.some((v) => v.id === tab.id);
      if (!stillExists) setTab("accounts");
    }
  }, [tab, reportViews]);

  function refreshReportViews() {
    setReportViewsVersion((v) => v + 1);
  }

  if (tab === null) {
    return <main className="container" />;
  }

  const activeReportView =
    tab && typeof tab !== "string" && tab.kind === "report"
      ? reportViews.find((v) => v.id === tab.id) ?? null
      : null;

  return (
    <main className="container">
      <Tabs active={tab} reportViews={reportViews} onChange={setTab} />
      {tab === "categories" && <CategoriesPage />}
      {tab === "accounts" && (
        <AccountsPage
          onCreateAccount={() => setCreatingAccount(true)}
          version={accountsVersion}
          onOpenMonth={openAccountMonthInTransactions}
          onImportAccount={(accountId) => setImportState({ accountId })}
        />
      )}
      {tab === "transactions" && (
        <TransactionsPage
          selectedAccountIds={txnFilterAccountIds}
          onChangeSelectedAccountIds={setTxnFilterAccountIds}
          version={accountsVersion}
          onImportTransactions={() => setImportState({ accountId: null })}
          pendingMonthFilter={txnPendingMonth}
          onPendingMonthFilterApplied={() => setTxnPendingMonth(null)}
        />
      )}
      {tab === "settings" && <SettingsPage />}
      {activeReportView && (
        <ReportViewPage
          key={activeReportView.id}
          view={activeReportView}
          onSaved={refreshReportViews}
        />
      )}

      {creatingAccount && (
        <CreateAccountModal
          onClose={() => setCreatingAccount(false)}
          onCreated={() => {
            setCreatingAccount(false);
            setAccountsVersion((v) => v + 1);
          }}
        />
      )}

      {importState && (
        <ImportDialog
          initialAccountId={importState.accountId}
          onClose={() => setImportState(null)}
          onImported={() => setAccountsVersion((v) => v + 1)}
        />
      )}
    </main>
  );
}

export default App;
