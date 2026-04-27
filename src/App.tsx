import { useState } from "react";

import "./App.css";
import { Tab, Tabs } from "./components/Tabs";
import { Toolbar } from "./components/Toolbar";
import { AccountsPage, CreateAccountModal } from "./pages/Accounts";
import { CategoriesPage } from "./pages/Categories";
import { SettingsPage } from "./pages/Settings";
import { TransactionsPage } from "./pages/Transactions";

function App() {
  const [tab, setTab] = useState<Tab>("accounts");
  const [txnFilterAccountIds, setTxnFilterAccountIds] = useState<number[]>([]);
  const [toolbarExpanded, setToolbarExpanded] = useState(true);
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [accountsVersion, setAccountsVersion] = useState(0);

  function goToTransactions(accountIds: number[]) {
    setTxnFilterAccountIds(accountIds);
    setTab("transactions");
  }

  return (
    <main className="container">
      <Toolbar
        expanded={toolbarExpanded}
        onToggle={() => setToolbarExpanded((v) => !v)}
        onCreateAccount={() => setCreatingAccount(true)}
      />
      <Tabs active={tab} onChange={setTab} />
      {tab === "categories" && <CategoriesPage />}
      {tab === "accounts" && (
        <AccountsPage
          onGoToTransactions={goToTransactions}
          version={accountsVersion}
        />
      )}
      {tab === "transactions" && (
        <TransactionsPage
          selectedAccountIds={txnFilterAccountIds}
          onChangeSelectedAccountIds={setTxnFilterAccountIds}
          version={accountsVersion}
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
    </main>
  );
}

export default App;
