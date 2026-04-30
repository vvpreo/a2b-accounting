import { useEffect, useState } from "react";

import "./App.css";
import { Tab, Tabs } from "./components/Tabs";
import { listReportViews, listTransactions, ReportView } from "./lib/api";
import { AccountsPage, CreateAccountModal } from "./pages/Accounts";
import { CategoriesPage } from "./pages/Categories";
import { ImportDialog } from "./pages/ImportDialog";
import { ReportsBuilderPage } from "./pages/ReportsBuilder";
import { ReportViewPage } from "./pages/ReportView";
import { SettingsPage } from "./pages/Settings";
import { TransactionsPage } from "./pages/Transactions";

function App() {
  // On startup we land on Transactions if any exist, otherwise Accounts. We
  // hold off rendering the page area until that check resolves so the user
  // doesn't see a brief flash of the wrong tab.
  const [tab, setTab] = useState<Tab | null>(null);
  const [txnFilterAccountIds, setTxnFilterAccountIds] = useState<number[]>([]);
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [importingTxns, setImportingTxns] = useState(false);
  const [accountsVersion, setAccountsVersion] = useState(0);

  const [reportViews, setReportViews] = useState<ReportView[]>([]);
  const [reportViewsVersion, setReportViewsVersion] = useState(0);
  // The editor lives inside the active report tab. Switching tabs discards it.
  const [editingReport, setEditingReport] = useState(false);

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

  function changeTab(next: Tab) {
    // Switching tabs always exits the report editor.
    setEditingReport(false);
    setTab(next);
  }

  function refreshReportViews() {
    setReportViewsVersion((v) => v + 1);
  }

  function goToTransactions(accountIds: number[]) {
    setTxnFilterAccountIds(accountIds);
    setTab("transactions");
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
      <Tabs active={tab} reportViews={reportViews} onChange={changeTab} />
      {tab === "categories" && <CategoriesPage />}
      {tab === "accounts" && (
        <AccountsPage
          onGoToTransactions={goToTransactions}
          onCreateAccount={() => setCreatingAccount(true)}
          version={accountsVersion}
        />
      )}
      {tab === "transactions" && (
        <TransactionsPage
          selectedAccountIds={txnFilterAccountIds}
          onChangeSelectedAccountIds={setTxnFilterAccountIds}
          version={accountsVersion}
          onImportTransactions={() => setImportingTxns(true)}
        />
      )}
      {tab === "settings" && <SettingsPage />}
      {activeReportView && editingReport && (
        <ReportsBuilderPage
          view={activeReportView}
          onSaved={() => {
            refreshReportViews();
            setEditingReport(false);
          }}
          onCancel={() => setEditingReport(false)}
        />
      )}
      {activeReportView && !editingReport && (
        <ReportViewPage
          view={activeReportView}
          onEdit={() => setEditingReport(true)}
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

      {importingTxns && (
        <ImportDialog
          onClose={() => setImportingTxns(false)}
          onImported={() => setAccountsVersion((v) => v + 1)}
        />
      )}
    </main>
  );
}

export default App;
