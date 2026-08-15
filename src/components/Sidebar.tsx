import { useState } from "react";
import type { SessionSummary } from "@deepseek-ai/dsh-host-apiproxy/api";
import { useAppState, appStore } from "../lib/dsh/store";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { DshStatus } from "../lib/tauri";
import { displayTitle } from "../lib/dsh/sessionTitle";

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
  const [ctx, setCtx] = useState<{ x: number; y: number; id: SessionId } | null>(null);
  const [renameCtx, setRenameCtx] = useState<{ id: SessionId; title: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const { pinnedSessions, workspaces, archivedSessionIds, sessionTitles } = useAppState();
  // 归档（移除）的会话不再显示在左侧列表；dsh 的 sessions.list 会返回全部会话，需用归档集合过滤
  const visible = sessions.filter((s) => !archivedSessionIds.includes(s.sessionId));
  const pinned = visible.filter((s) => pinnedSessions.includes(s.sessionId));
  const unpinned = visible.filter((s) => !pinnedSessions.includes(s.sessionId));
  const fmtTime = (ms: number) => {
    const d = new Date(ms);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "昨天";
  };
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const taskItem = (s: SessionSummary) => (
    <button
      key={s.sessionId}
      className={`task-item${s.sessionId === selectedSessionId && (view === "session" || view === "code") ? " active" : ""}`}
      onClick={() => onSelectSession(s.sessionId)}
      onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, id: s.sessionId }); }}
      onDoubleClick={() => {
        const cur = displayTitle(s, sessionTitles) ?? s.sessionId;
        setRenameCtx({ id: s.sessionId, title: cur });
        setRenameDraft(cur);
      }}
    >
      <span className={`dot${s.running ? " green" : ""}`} />
      <span className="t-title">{displayTitle(s, sessionTitles) ?? s.sessionId.slice(0, 8)}</span>
      <span className="t-time">{fmtTime(s.updatedAt)}</span>
    </button>
  );
  const groupByWs = (list: SessionSummary[]) => {
    const groups: Array<{ key: string; title: string; items: SessionSummary[] }> = [];
    const map = new Map<string, SessionSummary[]>();
    for (const s of list) {
      const ws = workspaces.find((w) => w.sessionIds.includes(s.sessionId));
      const key = ws ? ws.workspaceId : "ungrouped";
      let arr = map.get(key);
      if (!arr) { arr = []; map.set(key, arr); }
      arr.push(s);
    }
    for (const [key, items] of map) {
      const ws = workspaces.find((w) => w.workspaceId === key);
      groups.push({ key, title: ws ? ws.title : "未分组", items });
    }
    return groups;
  };
  const renderGroup = (g: { key: string; title: string; items: SessionSummary[] }, prefix: string) => {
    const ck = prefix + g.key;
    const open = !collapsed[ck];
    return (
      <div key={ck}>
        <div className="ws-group-head" onClick={() => setCollapsed((m) => ({ ...m, [ck]: open }))}>
          <span className="arrow">{open ? "▾" : "›"}</span>
          <span>{g.title}</span>
          <span className="count">{g.items.length}</span>
        </div>
        {open && g.items.map(taskItem)}
      </div>
    );
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
        {pinnedOpen && pinned.length === 0 && <div className="empty-state" style={{ padding: "6px 4px", textAlign: "left" }}>暂无置顶任务</div>}
        {pinnedOpen && groupByWs(pinned).map((g) => renderGroup(g, "p:"))}
      </div>
      <div className="side-block">
        <div className="side-head" onClick={() => setTasksOpen((v) => !v)}>
          <span>任务列表</span><span className="arrow">{tasksOpen ? "▾" : "›"}</span>
        </div>
        {tasksOpen && unpinned.length === 0 && <div className="empty-state" style={{ padding: "8px 4px" }}>暂无会话</div>}
        {tasksOpen && groupByWs(unpinned).map((g) => renderGroup(g, "t:"))}
      </div>
      {ctx && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 150 }} onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }} />
          <div className="model-menu" style={{ left: ctx.x, top: ctx.y, right: "auto", bottom: "auto", minWidth: 140, zIndex: 151 }}>
            <button
              className="mm-item"
              onClick={() => {
                appStore.togglePinned(ctx.id);
                setCtx(null);
              }}
            >
              {pinnedSessions.includes(ctx.id) ? "取消置顶" : "置顶"}
            </button>
            <button
              className="mm-item"
              onClick={() => {
                const s = sessions.find((x) => x.sessionId === ctx.id);
                const cur = s ? (displayTitle(s, sessionTitles) ?? s.sessionId) : ctx.id;
                setRenameCtx({ id: ctx.id, title: cur });
                setRenameDraft(cur);
                setCtx(null);
              }}
            >
              重命名
            </button>
            <button
              className="mm-item"
              onClick={() => {
                void appStore.archiveSession(ctx.id);
                setCtx(null);
              }}
            >
              移除（归档）
            </button>
          </div>
        </>
      )}
      {renameCtx && (
        <div className="modal-mask" onClick={() => setRenameCtx(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h4>重命名会话</h4>
            <div className="hint">手动命名会固定标题，dsh 将不再按会话内容自动重命名。</div>
            <div className="field">
              <label>标题</label>
              <input type="text" value={renameDraft} onChange={(e) => setRenameDraft(e.currentTarget.value)} autoFocus />
            </div>
            <div className="modal-row">
              <button className="btn" onClick={() => setRenameCtx(null)}>取消</button>
              <button
                className="btn primary"
                disabled={!renameDraft.trim()}
                onClick={() => {
                  void appStore.renameSession(renameCtx.id, renameDraft);
                  setRenameCtx(null);
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
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




