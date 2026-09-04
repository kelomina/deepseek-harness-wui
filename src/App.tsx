import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
import { SetupWizard } from "./components/SetupWizard";
import { GlobalLoading } from "./components/GlobalLoading";
import { withLoading, isDedupError, isCancelError } from "./lib/loading";
import type { PrereqCheck } from "./lib/tauri";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

export default function App() {
  const [view, setView] = useState<View>("welcome");
  const [toolTab, setToolTab] = useState<ToolTab>("files");
  const [toolDockOpen, setToolDockOpen] = useState(false);
  const [sessionSubTab, setSessionSubTab] = useState<SessionSubTab>("queue");
  const [mode, setMode] = useState<Mode>("work");
  // 首启前置条件门控：checking → needed（显示安装向导）/ ready（正常初始化）
  const [setup, setSetup] = useState<"checking" | "needed" | "ready">("checking");
  const [prereqInitial, setPrereqInitial] = useState<PrereqCheck | null>(null);
  const { sessions, selectedSessionId, status, error, notice } = useAppState();

  useEffect(() => {
    (async () => {
      try {
        // PRD-002：首检走全局 Loading（>800ms 必现，<800ms 不闪；可取消只读组）。
        const c = await withLoading<PrereqCheck | null>(
          "prereq_check_cmd",
          "正在检测运行环境…",
          () => invoke<PrereqCheck | null>("prereq_check_cmd"),
          { stage: "正在检测…" },
        );
        // c 为 null/异常（旧 mock 环境）不阻塞主流程
        if (c && typeof c === "object") {
          setPrereqInitial(c);
          if (c.ok === false) {
            setSetup("needed");
            return;
          }
        }
      } catch (e) {
        // 去重/取消不阻塞主流程（StrictMode 双 effect 去重 / 用户 Esc 取消等待）
        if (isDedupError(e) || isCancelError(e)) return;
        // 忽略：探测命令不可用时不阻塞
      }
      setSetup("ready");
      void appStore.init();
    })();
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
          {setup === "checking" && <div className="empty-state" style={{ margin: "auto" }}>正在检测运行环境…</div>}
          {setup !== "checking" && (
            <>
              {view === "welcome" && <WelcomeView mode={mode} onEnterSession={() => setView(mode === "code" ? "code" : "session")} onOpenSettings={() => setView("settings")} onOpenToolDock={openToolDock} />}
              {view === "session" && <WorkSessionView onOpenSettings={() => setView("settings")} onOpenToolDock={openToolDock} onOpenSessionDock={openSessionDock} />}
              {view === "code" && <CodeView />}
              {view === "status" && <StatusPage />}
              {view === "workspaces" && <WorkspacesPage />}
              {view === "settings" && <SettingsPage onStartSession={() => setView(mode === "code" ? "code" : "session")} />}
            </>
          )}
          {toolDockOpen && view !== "code" && setup !== "checking" && (
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
      {setup === "needed" && prereqInitial && (
        <SetupWizard
          prereq={prereqInitial}
          onDone={() => {
            setSetup("ready");
            void appStore.init();
          }}
        />
      )}
      {notice && (
        <div className="notice-banner" title={notice}>
          <span>{notice}</span>
          <button className="btn sm subtle" onClick={() => appStore.setNotice(null)}>关闭</button>
        </div>
      )}
      {error && (
        <ErrorBanner
          message={error}
          onDismiss={() => appStore.setError(null)}
          onViewLogs={() => openToolDock("logs")}
        />
      )}
      <GlobalLoading />
    </>
  );
}


