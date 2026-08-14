import { useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import { sessionTitle } from "../lib/dsh/sessionTitle";
import { ApprovalCard, EventRow, QuestionCard, shortId, useConversationItems, useSessionInteractives } from "../components/Conversation";
import { ModelMenu } from "../components/ModelMenu";
import { WorkspaceMenu } from "../components/WorkspaceMenu";

export function WorkSessionView({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { connected, sessions, selectedSessionId } = useAppState();
  const [draft, setDraft] = useState("");
  const items = useConversationItems();
  const interactives = useSessionInteractives();
  const selected = sessions.find((s) => s.sessionId === selectedSessionId);
  const running = selected?.running ?? false;


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
            <WorkspaceMenu />

          </div>
        </div>
      </div>
    </section>
  );
}


