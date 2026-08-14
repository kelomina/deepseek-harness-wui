import { useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import { sessionTitle } from "../lib/dsh/sessionTitle";
import { ApprovalCard, EventRow, QuestionCard, shortId, useConversationItems, useSessionInteractives } from "../components/Conversation";

export function WorkSessionView() {
  const { connected, sessions, selectedSessionId, host, activeWorkspaceId, workspaces } = useAppState();
  const [draft, setDraft] = useState("");
  const items = useConversationItems();
  const interactives = useSessionInteractives();
  const selected = sessions.find((s) => s.sessionId === selectedSessionId);
  const running = selected?.running ?? false;
  const activeWs = workspaces.find((w) => w.workspaceId === activeWorkspaceId) ?? null;

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
          <span className="conv-title">{selected ? (sessionTitle(selected) ?? shortId(selected.sessionId)) : "未选择会话"}</span>
          <span className={`badge ${running ? "orange" : "gray"}`}>{running ? "运行中" : "已停止"}</span>
        </div>
        <div className="msgs">
          {interactives.map((i) => (i.kind === "approval" ? <ApprovalCard key={i.rpcId} item={i} /> : <QuestionCard key={i.rpcId} item={i} />))}
          {items.length === 0 && <div className="empty-state">还没有消息</div>}
          {items.map((it) => <EventRow key={it.seq} item={it} />)}
        </div>
        <div className="composer-wrap">
          <div className="composer">
            <div className="ph">输入消息…</div>
            <div className="toolbar">
              <div className="tools"><button className="plus-btn" title="附件（开发中）">+</button></div>
              <div className="tools">
                <button className="model-btn" title="配置模型">
                  <span className="name">{host?.model ?? "DeepSeek-V4-Flash-0731(Default)"}</span>
                  <span className="caret">▾</span>
                </button>
                <button
                  className={`send-btn${running ? " stop" : ""}`}
                  title={running ? "停止当前任务" : "发送消息"}
                  disabled={!connected}
                  onClick={() => (running && selectedSessionId ? void appStore.cancelSession(selectedSessionId) : send())}
                >
                  {running ? "■" : "↑"}
                </button>
              </div>
            </div>
          </div>
          <div className="env-bar">
            <button className="env-btn" title="执行环境（开发中）">本地 <span className="caret">▾</span></button>
            <span className="folder">📁 {activeWs?.path ?? "未选择工作区"}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
