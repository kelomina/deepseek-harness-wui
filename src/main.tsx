import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { appStore } from "./lib/dsh/store";
import "./styles/fluent.css";

void appStore.init();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
