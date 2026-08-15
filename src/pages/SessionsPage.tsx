import { useMemo, useState } from "react";
import { appStore, useAppState, type InteractiveItem } from "../lib/dsh/store";
import { Badge, formatTime, shortId } from "../components/ui";
import { normalizeConversation } from "../lib/dsh/render";
import { ToolEventCard } from "../components/ToolCards";

interface HistoryEntryLike {
  seq: number;
  event: { type: string; seq: number; time: number; data: Record<string, unknown> };
  view?: unknown;
}


function sessionTitle(s: { sessionId: string; projections?: unknown }): string | null {
  const p = s.projections as Record<string, { value?: unknown }> | undefined;
  if (p) {
    for (const key of Object.keys(p)) {
      const v = p[key]?.value;
      if (typeof v === "string" && v) return v;
    }
  }
  return null;
}

function EventRow({ item }: { item: ReturnType<typeof normalizeConversation>[number] }) {
  switch (item.kind) {
    case "user":
      return <div className="msg user"><div className="meta">{formatTime(item.time)}</div>{item.userText || "(空)"}</div>;
    case "assistant":
      return (
        <div className="msg assistant">
          <div className="meta">{formatTime(item.time)}</div>
          {item.reasoning && (
            <details className="reasoning-details">
              <summary>思考过程</summary>
              <div className="reasoning-body">{item.reasoning}</div>
            </details>
          )}
          {item.text ?? ""}
        </div>
      );
    case "tool":
      return (
        <div className="toolcall-wrap" title={`${item.event.type} @${item.seq}`}>
          <ToolEventCard view={item.view} evType={item.event.type} data={item.event.data} seq={item.seq} />
        </div>
      );
    case "error":
      return <div className="toolcall toolcall-err">{item.errorText ?? `${item.event.type} @${item.seq}`}</div>;
    case "info":
      return (
        <details className="reasoning-details" open>
          <summary>思考过程</summary>
          <div className="reasoning-body">{item.reasoning}</div>
        </details>
      );
    default:
      return null;
  }
}

function ApprovalCard({ item }: { item: InteractiveItem }) {
  if (item.frame.type !== "approval/requested") return null;
  return (
    <div className="card" style={{ alignSelf: "center", width: "100%", maxWidth: 640, marginBottom: 0 }}>
      <h2 style={{ marginBottom: 8 }}>需要审批：{item.frame.toolName}</h2>
      {item.frame.reason && <div className="muted" style={{ marginBottom: 8 }}>{item.frame.reason}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary sm" onClick={() => void appStore.answerApproval(item, "allowed-once")}>允许一次</button>
        <button className="btn danger sm" onClick={() => void appStore.answerApproval(item, "rejected")}>拒绝</button>
      </div>
    </div>
  );
}

function QuestionCard({ item }: { item: InteractiveItem }) {
  const [answer, setAnswer] = useState("");
  return (
    <div className="card" style={{ alignSelf: "center", width: "100%", maxWidth: 640, marginBottom: 0 }}>
      <h2 style={{ marginBottom: 8 }}>提问</h2>
      <div className="muted" style={{ marginBottom: 8 }}>{JSON.stringify(item.frame).slice(0, 300)}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="input" value={answer} onChange={(e) => setAnswer(e.currentTarget.value)} placeholder="回答" />
        <button className="btn primary" disabled={!answer.trim()} onClick={() => void appStore.answerQuestion(item, answer.trim())}>
          提交
        </button>
      </div>
    </div>
  );
}

export function SessionsPage() {
  const { sessions, connected, selectedSessionId, history, live, interactives } = useAppState();
  const [draft, setDraft] = useState("");

  const items = useMemo(() => {
    if (!selectedSessionId) return [];
    const map = new Map<number, HistoryEntryLike>();
    for (const h of (history.get(selectedSessionId) ?? []) as HistoryEntryLike[]) map.set(h.seq, h);
    for (const f of live.get(selectedSessionId) ?? []) {
      if (f.type === "session/event") {
        const ev = f.event as HistoryEntryLike["event"];
        map.set(ev.seq, { seq: ev.seq, event: ev, view: f.view });
      }
    }
    return normalizeConversation([...map.values()].sort((a, b) => a.seq - b.seq));
  }, [selectedSessionId, history, live]);

  const selected = sessions.find((s) => s.sessionId === selectedSessionId);
  const sessionInteractives = interactives.filter((i) => i.sessionId === selectedSessionId);

  const send = () => {
    const text = draft.trim();
    if (!text || !selectedSessionId) return;
    void appStore.sendPrompt(selectedSessionId, text);
    setDraft("");
  };

  return (
    <div className="sessions-layout">
      <div className="session-list-pane">
        <button className="btn primary" disabled={!connected} onClick={() => void appStore.createSession()}>
          + 新建会话
        </button>
        <div className="list" style={{ border: "1px solid var(--stroke-2)", borderRadius: 6, overflow: "auto", flex: 1 }}>
          {sessions.length === 0 && <div className="empty-state">暂无会话</div>}
          {sessions.map((s) => (
            <div
              key={s.sessionId}
              className={`list-item${s.sessionId === selectedSessionId ? " active" : ""}`}
              onClick={() => appStore.selectSession(s.sessionId)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="title">{sessionTitle(s) ?? shortId(s.sessionId)}</div>
                <div className="sub">{formatTime(s.updatedAt)} · {s.running ? "运行中" : s.blank ? "空白" : "空闲"}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="conversation-pane" style={{ border: "1px solid var(--stroke-2)", borderRadius: 8, overflow: "hidden" }}>
        {!selectedSessionId ? (
          <div className="empty-state">选择或新建一个会话</div>
        ) : (
          <>
            <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--stroke-2)", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 600, flex: 1 }}>{shortId(selectedSessionId)}</span>
              {selected?.running && <Badge tone="warn">运行中</Badge>}
              <button className="btn sm danger" disabled={!selected?.running} onClick={() => void appStore.cancelSession(selectedSessionId)}>
                停止
              </button>
            </div>
            <div className="conversation-scroll">
              {sessionInteractives.map((i) => (i.kind === "approval" ? <ApprovalCard key={i.rpcId} item={i} /> : <QuestionCard key={i.rpcId} item={i} />))}
              {items.length === 0 && <div className="empty-state">还没有消息</div>}
              {items.map((it) => <EventRow key={it.seq} item={it} />)}
            </div>
            <div className="composer">
              <textarea
                className="textarea"
                value={draft}
                disabled={!connected}
                placeholder="输入消息，Enter 发送，Shift+Enter 换行"
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button className="btn primary" disabled={!connected || !draft.trim()} onClick={send}>发送</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
