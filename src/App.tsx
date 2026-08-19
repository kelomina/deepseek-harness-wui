import { useEffect, useState } from "react";
import { appStore, useAppState } from "./lib/dsh/store";
import { ErrorBanner } from "./components/ui";
import { TitleBar } from "./components/TitleBar";
import { Sidebar, type Mode, type View } from "./components/Sidebar";
import { WelcomeView } from "./views/WelcomeView";
import { WorkSessionView } from "./views/WorkSessionView";
import { CodeView } from "./views/CodeView";
import { StatusPage } from "./pages/StatusPage";
import { WorkspacesPage } from "./pages/WorkspacesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ToolDock, type ToolTab, type SessionSubTab } from "./components/ToolDock";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

export default function App() {
  const [view, setView] = useState<View>("welcome");
  const [toolTab, setToolTab] = useState<ToolTab>("files");
  const [toolDockOpen, setToolDockOpen] = useState(false);
  const [sessionSubTab, setSessionSubTab] = useState<SessionSubTab>("goal");
  const [mode, setMode] = useState<Mode>("work");
  const { sessions, selectedSessionId, status, error, notice } = useAppState();

  useEffect(() => {
    void appStore.init();
  }, []);

  const navigate = (v: View) => setView(v);
  const openToolDock = (t: ToolTab) => {
    setToolTab(t);
    setToolDockOpen(true);
  };
  const openSessionDock = (sub: SessionSubTab) => {
    setToolTab("session");
    setToolDockOpen(true);
    setSessionSubTab(sub);
  };
  const closeToolDock = () => setToolDockOpen(false);
  const selectSession = (id: SessionId) => {
    appStore.selectSession(id);
    setView(mode === "code" ? "code" : "session");
  };
  const modeChange = (m: Mode) => {
    setMode(m);
    if (view === "session" || view === "code") setView(m === "code" ? "code" : "session");
  };

  return (
    <>
      <TitleBar />
      <div className="layout">
        <Sidebar
          mode={mode}
          view={view}
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          status={status}
          onModeChange={modeChange}
          onNavigate={navigate}
          onSelectSession={selectSession}
        />
        <main className="main">
          {view === "welcome" && <WelcomeView mode={mode} onEnterSession={() => setView(mode === "code" ? "code" : "session")} onOpenSettings={() => setView("settings")} onOpenToolDock={openToolDock} />}
          {view === "session" && <WorkSessionView onOpenSettings={() => setView("settings")} onOpenToolDock={openToolDock} onOpenSessionDock={openSessionDock} />}
          {view === "code" && <CodeView />}
          {view === "status" && <StatusPage />}
          {view === "workspaces" && <WorkspacesPage />}
          {view === "settings" && <SettingsPage onStartSession={() => setView(mode === "code" ? "code" : "session")} />}
          {toolDockOpen && view !== "code" && (
            <ToolDock
              tab={toolTab}
              onTabChange={setToolTab}
              onClose={closeToolDock}
              sessionSubTab={sessionSubTab}
              onSessionSubTabChange={setSessionSubTab}
            />
          )}
        </main>
      </div>
      {notice && (
        <div className="notice-banner" title={notice}>
          <span>{notice}</span>
          <button className="btn sm subtle" onClick={() => appStore.setNotice(null)}>关闭</button>
        </div>
      )}
      {error && <ErrorBanner message={error} onDismiss={() => appStore.setError(null)} />}
    </>
  );
}


