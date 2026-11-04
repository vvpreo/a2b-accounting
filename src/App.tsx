import { useEffect, useState } from "react";

import "./App.css";
import { Tab, Tabs } from "./components/Tabs";
import { getSetting, listReportViews, listTransactions, ReportView } from "./lib/api";
import {
  DEFAULT_START_SCREEN,
  needsTransactionCheck,
  parseStartScreen,
  resolveStartTab,
  SETTING_KEY_START_SCREEN,
} from "./lib/start-screen";
import { AccountsPage, CreateAccountModal } from "./pages/Accounts";
import { CategoriesPage } from "./pages/Categories";
import { DocumentsPage } from "./pages/Documents";
import { ContextPage } from "./pages/Context";
import { GuidePage } from "./pages/Guide";
import { useViewState } from "./lib/view-state";
import { ImportDialog } from "./pages/ImportDialog";
import { ReportViewPage } from "./pages/ReportView";
import { SettingsPage } from "./pages/Settings";
import { TransactionsPage } from "./pages/Transactions";

function App() {
  // On startup we land on the screen chosen in Settings (start_screen); the
  // default "auto" means Transactions if any exist, otherwise Accounts. We
  // hold off rendering the page area until that check resolves so the user
  // doesn't see a brief flash of the wrong tab.
  const [tab, setTab] = useState<Tab | null>(null);
  const [txnFilterAccountIds, setTxnFilterAccountIds] = useViewState<number[]>(
    "transactions.accountIds",
    [],
  );
  // One-shot navigation hint emitted when the user clicks a month cell on
  // the Accounts tab: TransactionsPage consumes it on mount/update to apply
  // the date range, then calls back to clear it so subsequent navigations
  // (or manual filter changes) aren't overwritten by the same hint twice.
  const [txnPendingMonth, setTxnPendingMonth] = useState<{
    accountId: number;
    yearMonth: string;
  } | null>(null);
  const [creatingAccount, setCreatingAccount] = useState(false);
  // null = import dialog closed. Otherwise the dialog is open with the account
  // of the Accounts tab's per-row Import button preselected.
  const [importState, setImportState] = useState<{
    accountId: number;
  } | null>(null);
  const [accountsVersion, setAccountsVersion] = useState(0);

  function openAccountMonthInTransactions(accountId: number, yearMonth: string) {
    setTxnFilterAccountIds([accountId]);
    setTxnPendingMonth({ accountId, yearMonth });
    setTab("transactions");
  }

  // null until the first load finishes, so the dangling-report fallback below
  // doesn't fire against an empty list while a report is the start screen.
  const [reportViews, setReportViews] = useState<ReportView[] | null>(null);
  const [reportViewsVersion, setReportViewsVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [screen, views] = await Promise.all([
        getSetting(SETTING_KEY_START_SCREEN)
          .then(parseStartScreen)
          .catch(() => DEFAULT_START_SCREEN),
        listReportViews().catch(() => [] as ReportView[]),
      ]);
      const viewIds = views.map((v) => v.id);
      const hasTransactions = needsTransactionCheck(screen, viewIds)
        ? await listTransactions(undefined)
            .then((txns) => txns.length > 0)
            .catch(() => false)
        : false;
      if (!cancelled) setTab(resolveStartTab(screen, viewIds, hasTransactions));
    })();
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
    if (reportViews && tab && typeof tab !== "string" && tab.kind === "report") {
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
      ? reportViews?.find((v) => v.id === tab.id) ?? null
      : null;

  return (
    <main className="container">
      <Tabs active={tab} reportViews={reportViews ?? []} onChange={setTab} />
      {tab === "guide" && <GuidePage reportViews={reportViews ?? []} onOpen={setTab} />}
      {tab === "context" && <ContextPage />}
      {tab === "documents" && <DocumentsPage />}
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
