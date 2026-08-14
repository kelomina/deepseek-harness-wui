import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { appStore } from "./lib/dsh/store";
import { invoke } from "@tauri-apps/api/core";
import "./styles/fluent.css";

const errors = (window as unknown as { __dshErrors?: string[] }).__dshErrors ?? [];
if (errors.length > 0) {
  errors.forEach((msg) => { void invoke("frontend_error", { message: msg }).catch(() => {}); });
  (window as unknown as { __dshErrors?: string[] }).__dshErrors = [];
}

void appStore.init();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

