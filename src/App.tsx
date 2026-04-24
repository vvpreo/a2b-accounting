import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function App() {
  const [dataDir, setDataDir] = useState<string>("");

  useEffect(() => {
    invoke<string>("data_dir").then(setDataDir);
  }, []);

  return (
    <main className="container">
      <h1>Hello, world!</h1>
      <p>
        Data directory: <code>{dataDir || "..."}</code>
      </p>
    </main>
  );
}

export default App;
