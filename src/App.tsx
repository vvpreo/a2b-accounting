import { useState } from "react";

import "./App.css";
import { Tab, Tabs } from "./components/Tabs";
import { AccountsPage, CreateAccountModal } from "./pages/Accounts";
import { CategoriesPage } from "./pages/Categories";
import { ImportDialog } from "./pages/ImportDialog";
import { SettingsPage } from "./pages/Settings";
import { TransactionsPage } from "./pages/Transactions";

function App() {
  const [tab, setTab] = useState<Tab>("accounts");
  const [txnFilterAccountIds, setTxnFilterAccountIds] = useState<number[]>([]);
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [importingTxns, setImportingTxns] = useState(false);
  const [accountsVersion, setAccountsVersion] = useState(0);

  function goToTransactions(accountIds: number[]) {
    setTxnFilterAccountIds(accountIds);
    setTab("transactions");
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
