import { useEffect, useRef, useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import { displayTitle } from "../lib/dsh/sessionTitle";
import { ApprovalCard, EventRow, LiveAssistantRow, QuestionCard, shortId, useConversationItems, useLiveAssistant, useSessionInteractives } from "../components/Conversation";
import { ModelMenu } from "../components/ModelMenu";
import { WorkspaceMenu } from "../components/WorkspaceMenu";
import { AgentPresetChip } from "../components/AgentPresetChip";
import { PermissionMenu } from "../components/PermissionMenu";
import { CotWarningBanner } from "../components/CotWarningBanner";

export function WorkSessionView({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { connected, sessions, selectedSessionId, history, stoppingSessions, sessionTitles } = useAppState();
  const [draft, setDraft] = useState("");
  const msgsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedSessionId && !history.has(selectedSessionId) && appStore.get().api) {
      void appStore.loadHistory(selectedSessionId).catch((e) => appStore.set({ error: `历史加载失败: ${String(e)}` }));
    }
  }, [selectedSessionId, history]);

  const items = useConversationItems();
  const liveAssistant = useLiveAssistant();
  // 贴底滚动：消息变化或流式内容增长时若用户已在底部则跟随到底部（不打断上翻查看历史）
  useEffect(() => {
    const el = msgsRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items.length, liveAssistant?.text.length, liveAssistant?.reasoning.length]);
  const interactives = useSessionInteractives();
  const reasoningText = [
    liveAssistant?.reasoning ?? "",
    ...items.filter((it) => it.kind === "assistant").map((it) => it.reasoning ?? ""),
  ].join("\n");
  const selected = sessions.find((s) => s.sessionId === selectedSessionId);
  const running = selected?.running ?? false;
  const stopping = selectedSessionId ? (stoppingSessions[selectedSessionId] ?? null) : null;

  // 会话重命名（内联）：铅笔 → 输入框；Enter/失焦保存，Esc 取消
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (!selected) return;
    renameCommittedRef.current = false;
    setRenameDraft(displayTitle(selected, sessionTitles) ?? shortId(selected.sessionId));
    setRenaming(true);
  };
  const cancelRename = () => {
    renameCommittedRef.current = true;
    setRenaming(false);
  };
  const commitRename = () => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const t = renameDraft.trim();
    setRenaming(false);
    if (t && selected) void appStore.renameSession(selected.sessionId, t);
  };


  const send = () => {
    const text = draft.trim();
    if (!text || !selectedSessionId || !connected) return;
    void appStore.sendPrompt(selectedSessionId, text);
    setDraft("");
  };

  return (
    <section className="view active" id="view-session">
      <div className="col col-conv">
        <div className="view-cap">会话</div>
        <div className="conv-head">
          <div className="conv-title-wrap">
            {renaming && selected ? (
              <input
                className="conv-rename-input"
                value={renameDraft}
                autoFocus
                onChange={(e) => setRenameDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                  if (e.key === "Escape") cancelRename();
                }}
                onBlur={commitRename}
              />
            ) : (
              <>
                <span className="conv-title">{selected ? (displayTitle(selected, sessionTitles) ?? shortId(selected.sessionId)) : "未选择会话（从左侧任务列表选择）"}</span>
                {selected && (
                  <button className="conv-rename-btn" title="重命名会话" disabled={!connected} onClick={startRename}>✎</button>
                )}
              </>
            )}
          </div>
          <span className={`badge ${running ? "orange" : "gray"}`}>{running ? "运行中" : "已停止"}</span>
          {stopping && <span className="badge orange">正在停止…</span>}
        </div>
        <div className="msgs" ref={msgsRef}>
          {selectedSessionId && <CotWarningBanner sessionId={selectedSessionId} reasoning={reasoningText} />}
          {interactives.map((i) => (i.kind === "approval" ? <ApprovalCard key={i.rpcId} item={i} /> : <QuestionCard key={i.rpcId} item={i} />))}
          {items.length === 0 && <div className="empty-state">还没有消息</div>}
          {items.map((it) => <EventRow key={it.seq} item={it} sessionId={selectedSessionId ?? undefined} />)}
          <LiveAssistantRow />
          {stopping ? <div className="thinking-indicator">■ 正在停止生成…（2 秒内切换为已停止）</div> : running && !liveAssistant ? <div className="thinking-indicator">● 模型正在思考中…</div> : null}
        </div>
        <div className="composer-wrap">
          <div className="composer">
            <textarea
              className="composer-input"
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              placeholder="输入消息…"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="toolbar">
              <div className="tools"><button className="plus-btn" title="附件（开发中）">+</button></div>
              <div className="tools">
                <ModelMenu onOpenSettings={onOpenSettings} />
                <button
                  className={`send-btn${running ? " stop" : ""}`}
                  title={stopping ? "正在停止…" : running ? "停止当前任务" : "发送消息"}
                  disabled={!connected || !!stopping}
                  onClick={() => (running && selectedSessionId ? void appStore.stopSession(selectedSessionId) : send())}
                >
                  {running ? "■" : "↑"}
                </button>
              </div>
            </div>
          </div>
          <div className="env-bar">
            {selectedSessionId ? <PermissionMenu sessionId={selectedSessionId} /> : null}
            <button className="env-btn" title="执行环境（开发中）">本地 <span className="caret">▾</span></button>
            <WorkspaceMenu />
            {selectedSessionId ? <AgentPresetChip sessionId={selectedSessionId} /> : null}
          </div>
        </div>
      </div>
    </section>
  );
}








