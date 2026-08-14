import { useEffect, useState } from "react";
import { appStore, useAppState } from "./lib/dsh/store";
import { dsh } from "./lib/tauri";
import { Badge, ErrorBanner } from "./components/ui";
import { StatusPage } from "./pages/StatusPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";
import { SessionsPage } from "./pages/SessionsPage";

type Page = "status" | "settings" | "workspaces" | "sessions";

const PAGES: Array<{ id: Page; label: string }> = [
  { id: "status", label: "连接状态" },
  { id: "workspaces", label: "工作区" },
  { id: "sessions", label: "会话" },
  { id: "settings", label: "设置" },
];

const PAGE_TITLE: Record<Page, string> = {
  status: "连接状态",
  settings: "设置",
  workspaces: "工作区",
  sessions: "会话",
};

const STATE_LABEL: Record<string, { text: string; tone: "ok" | "err" | "warn" | "brand" }> = {
  running: { text: "运行中", tone: "ok" },
  starting: { text: "启动中", tone: "warn" },
  stopped: { text: "已停止", tone: "brand" },
  error: { text: "错误", tone: "err" },
};

export default function App() {
  const [page, setPage] = useState<Page>("status");
  const { status, error, connected } = useAppState();

  useEffect(() => {
    void appStore.init();
  }, []);

  const running = status?.state === "running";
  const label = STATE_LABEL[status?.state ?? "stopped"] ?? STATE_LABEL.stopped;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="app-title">DeepSeek Harness</div>
        <nav>
          {PAGES.map((p) => (
            <button key={p.id} className={`nav-item${page === p.id ? " active" : ""}`} onClick={() => setPage(p.id)}>
              {p.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="side-status">
          <Badge tone={label.tone}>{label.text}</Badge>
          <span>{status?.port ?? "-"}</span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <h1>{PAGE_TITLE[page]}</h1>
          {connected && <Badge tone="ok">协议已连接</Badge>}
          <button className="btn sm" disabled={running} onClick={() => void dsh.start()}>启动</button>
          <button className="btn sm" disabled={!running} onClick={() => void dsh.stop()}>停止</button>
        </header>
        {error && <ErrorBanner message={error} onDismiss={() => appStore.setError(null)} />}
        <div className="content">
          {page === "status" && <StatusPage />}
          {page === "settings" && <SettingsPage />}
          {page === "workspaces" && <WorkspacesPage />}
          {page === "sessions" && <SessionsPage />}
        </div>
      </div>
    </div>
  );
}
