import "./lib/migrateStorage";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { ThemeProvider } from "./app/ThemeProvider";

import { invoke } from "@tauri-apps/api/core";

async function init() {
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      const [port, token] = await invoke<[number, string]>("get_backend_config");
      (window as any).__PAPEER_PORT = port;
      (window as any).__PAPEER_TOKEN = token;
    } catch (e) {
      console.warn("Failed to fetch backend config", e);
    }
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ThemeProvider defaultTheme="system" storageKey="papeer-ui-theme">
        <App />
      </ThemeProvider>
    </React.StrictMode>,
  );
}

init();
