import { useState } from "react";

import { AccountsPage } from "./pages/Accounts";
import { AccountTransactionsPage } from "./pages/AccountTransactions";
import "./App.css";

type View =
  | { kind: "accounts" }
  | { kind: "transactions"; accountId: number };

function App() {
  const [view, setView] = useState<View>({ kind: "accounts" });

  return (
    <main className="container">
      <header className="app-header">
        <h1>Finances v2</h1>
      </header>
      {view.kind === "accounts" && (
        <AccountsPage
          onSelectAccount={(id) =>
            setView({ kind: "transactions", accountId: id })
          }
        />
      )}
      {view.kind === "transactions" && (
        <AccountTransactionsPage
          accountId={view.accountId}
          onBack={() => setView({ kind: "accounts" })}
        />
      )}
    </main>
  );
}

export default App;
