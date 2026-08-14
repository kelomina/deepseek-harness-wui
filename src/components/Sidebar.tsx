import { useState } from "react";
import type { SessionSummary } from "@deepseek-ai/dsh-host-apiproxy/api";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { DshStatus } from "../lib/tauri";
import { sessionTitle } from "../lib/dsh/sessionTitle";

export type View = "welcome" | "session" | "code" | "status" | "workspaces" | "settings";
export type Mode = "work" | "code";

export function Sidebar({
  mode,
  view,
  sessions,
  selectedSessionId,
  status,
  onModeChange,
  onNavigate,
  onSelectSession,
}: {
  mode: Mode;
  view: View;
  sessions: SessionSummary[];
  selectedSessionId: SessionId | null;
  status: DshStatus | null;
  onModeChange: (m: Mode) => void;
  onNavigate: (v: View) => void;
  onSelectSession: (id: SessionId) => void;
}) {
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(true);
  const fmtTime = (ms: number) => {
    const d = new Date(ms);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "昨天";
  };
  return (
    <aside className="sidebar">
      <div className="mode-tabs">
        <button className={`tab${mode === "work" ? " active" : ""}`} onClick={() => onModeChange("work")}>Work</button>
        <button className={`tab${mode === "code" ? " active" : ""}`} onClick={() => onModeChange("code")}>Code</button>
      </div>
      <nav className="nav">
        <button className={`nav-item${view === "welcome" ? " active" : ""}`} onClick={() => onNavigate("welcome")}>＋ 新建任务</button>
        <button className="nav-item" title="自动化（开发中）">自动化</button>
      </nav>
      <div className="side-block">
        <div className="side-head" onClick={() => setPinnedOpen((v) => !v)}>
          <span>置顶</span><span className="arrow">{pinnedOpen ? "▾" : "›"}</span>
        </div>
        {pinnedOpen && <div className="empty-state" style={{ padding: "6px 4px", textAlign: "left" }}>暂无置顶任务</div>}
      </div>
      <div className="side-block">
        <div className="side-head" onClick={() => setTasksOpen((v) => !v)}>
          <span>任务列表</span><span className="arrow">{tasksOpen ? "▾" : "›"}</span>
        </div>
        {tasksOpen && sessions.length === 0 && <div className="empty-state" style={{ padding: "8px 4px" }}>暂无会话</div>}
        {tasksOpen && sessions.map((s) => (
          <button
            key={s.sessionId}
            className={`task-item${s.sessionId === selectedSessionId && (view === "session" || view === "code") ? " active" : ""}`}
            onClick={() => onSelectSession(s.sessionId)}
          >
            <span className={`dot${s.running ? " green" : ""}`} />
            <span className="t-title">{sessionTitle(s) ?? s.sessionId.slice(0, 8)}</span>
            <span className="t-time">{fmtTime(s.updatedAt)}</span>
          </button>
        ))}
      </div>
      <div className="side-bottom">
        <button className={`nav-item${view === "status" ? " active" : ""}`} onClick={() => onNavigate("status")}>
          <span className={`dot${status?.state === "running" ? " green" : ""}`} />
          <span className="t-title">连接状态</span>
          <span className="t-time">{status?.port ?? "-"}</span>
        </button>
        <button className={`nav-item${view === "workspaces" ? " active" : ""}`} onClick={() => onNavigate("workspaces")}>工作区</button>
        <button className={`nav-item${view === "settings" ? " active" : ""}`} onClick={() => onNavigate("settings")}>设置 · API Key</button>
      </div>
    </aside>
  );
}



