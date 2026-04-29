import { useEffect, useState } from "react";

import "./App.css";
import { Tab, Tabs } from "./components/Tabs";
import { listTransactions } from "./lib/api";
import { AccountsPage, CreateAccountModal } from "./pages/Accounts";
import { CategoriesPage } from "./pages/Categories";
import { ImportDialog } from "./pages/ImportDialog";
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

  function goToTransactions(accountIds: number[]) {
    setTxnFilterAccountIds(accountIds);
    setTab("transactions");
  }

  if (tab === null) {
    return <main className="container" />;
  }

  return (
    <main className="container">
      <Tabs active={tab} onChange={setTab} />
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
