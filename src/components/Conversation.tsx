import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appStore, useAppState, type InteractiveItem, type LiveStream } from "../lib/dsh/store";
import { formatTime, shortId } from "./ui";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { RetractModal, type RevertInfo } from "./RetractModal";
import { Markdown } from "./Markdown";
import { normalizeConversation, type RenderItem } from "../lib/dsh/render";
import { ToolEventCard } from "./ToolCards";

interface HistoryEntryLike {
  seq: number;
  event: { type: string; seq: number; time: number; data: Record<string, unknown> };
  view?: unknown;
}

export function mergeItems(
  history: Map<string, unknown[]>,
  live: Map<string, unknown[]>,
  sessionId: string | null,
): HistoryEntryLike[] {
  if (!sessionId) return [];
  const map = new Map<number, HistoryEntryLike>();
  // dsh HistoryEntry 结构为 { event, view? }，seq 在 event.seq（没有顶层 seq）
  for (const raw of (history.get(sessionId) ?? []) as Array<{ event: HistoryEntryLike["event"]; view?: unknown }>) {
    const ev = raw.event;
    if (ev && typeof ev.seq === "number") {
      map.set(ev.seq, { seq: ev.seq, event: ev, view: raw.view });
    }
  }
  for (const f of (live.get(sessionId) ?? []) as Array<{ type: string; event: HistoryEntryLike["event"]; view?: unknown }>) {
    if (f.type === "session/event") {
      map.set(f.event.seq, { seq: f.event.seq, event: f.event, view: f.view });
    }
  }
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

function UserMessage({ text, time, sessionId, seq }: { text: string; time: number; sessionId?: SessionId; seq: number }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [retract, setRetract] = useState<{ sessionId: SessionId; seq: number; info: RevertInfo } | null>(null);
  return (
    <>
      <div
        className="msg-user"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <div className="msg-time">{formatTime(time)}</div>
        {text ? <Markdown text={text} /> : "(空)"}
      </div>
      {menu && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 150 }} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="model-menu" style={{ left: menu.x, top: menu.y, right: "auto", bottom: "auto", minWidth: 140, zIndex: 151 }}>
            <button
              className="mm-item"
              onClick={() => {
                void invoke("clipboard_write", { text }).catch((e) => appStore.set({ error: `复制失败: ${String(e)}` }));
                setMenu(null);
              }}
            >
              复制
            </button>
            <button
              className="mm-item"
              title="重试 = 撤回该消息（回退到上一轮边界）后重新发送，避免同一消息重复进入上下文"
              onClick={() => {
                if (sessionId) void appStore.retryMessage(sessionId, seq, text);
                setMenu(null);
              }}
            >
              重试
            </button>
            <button
              className="mm-item"
              onClick={() => {
                if (sessionId) void appStore.forkAt(sessionId, seq);
                setMenu(null);
              }}
            >
              分叉
            </button>
            <button
              className="mm-item"
              onClick={() => {
                if (sessionId) {
                  void (async () => {
                    try {
                      const info = await appStore.collectRevertInfo(sessionId, seq);
                      setRetract({ sessionId, seq, info });
                    } catch (e) {
                      appStore.set({ error: `撤回准备失败: ${String(e)}` });
                    }
                  })();
                }
                setMenu(null);
              }}
            >
              撤回…
            </button>
          </div>
        </>
      )}
      {retract ? (
        <RetractModal
          info={retract.info}
          onCancel={() => setRetract(null)}
          onMessagesOnly={() => {
            void appStore.retractMessage(retract.sessionId, retract.seq, false);
            setRetract(null);
          }}
          onConfirm={() => {
            void appStore.retractMessage(retract.sessionId, retract.seq, true);
            setRetract(null);
          }}
        />
      ) : null}
    </>
  );
}

function AssistantMessage({
  text,
  reasoning,
  time,
  sessionId,
  seq,
}: {
  text: string;
  reasoning?: string;
  time: number;
  sessionId?: SessionId;
  seq: number;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <div
        className="msg-ai"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <div className="msg-time">{formatTime(time)}</div>
        {reasoning && (
          <details className="reasoning-details">
            <summary>思考过程</summary>
            <div className="reasoning-body">{reasoning}</div>
          </details>
        )}
        {text ? <Markdown text={text} /> : null}
      </div>
      {menu && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 150 }} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="model-menu" style={{ left: menu.x, top: menu.y, right: "auto", bottom: "auto", minWidth: 140, zIndex: 151 }}>
            <button
              className="mm-item"
              onClick={() => {
                void invoke("clipboard_write", { text }).catch((e) => appStore.set({ error: `复制失败: ${String(e)}` }));
                setMenu(null);
              }}
            >
              复制
            </button>
            <button
              className="mm-item"
              onClick={() => {
                if (sessionId) void appStore.forkAt(sessionId, seq);
                setMenu(null);
              }}
            >
              分叉
            </button>
          </div>
        </>
      )}
    </>
  );
}

export function EventRow({ item, sessionId }: { item: RenderItem; sessionId?: SessionId }) {
  switch (item.kind) {
    case "user":
      return <UserMessage text={item.userText ?? ""} time={item.time} sessionId={sessionId} seq={item.seq} />;
    case "assistant":
      return <AssistantMessage text={item.text ?? ""} reasoning={item.reasoning} time={item.time} sessionId={sessionId} seq={item.seq} />;
    case "tool": {
      const data = (item.event.data ?? {}) as unknown;
      return (
        <div className="toolcall-wrap" title={`${item.event.type} @${item.seq}`}>
          <ToolEventCard view={item.view} evType={item.event.type} data={data} seq={item.seq} />
          {item.turnReasoning && (
            <details className="reasoning-details">
              <summary>思考过程</summary>
              <div className="reasoning-body">{item.turnReasoning}</div>
            </details>
          )}
        </div>
      );
    }
    case "error":
      return <div className="toolcall toolcall-err" title={`${item.event.type} @${item.seq}`}>{item.errorText ?? `${item.event.type} @${item.seq}`}</div>;
    case "info":
      return (
        <div className="toolcall-wrap">
          <details className="reasoning-details" open>
            <summary>思考过程</summary>
            <div className="reasoning-body">{item.reasoning}</div>
          </details>
        </div>
      );
    default:
      return null;
  }
}

export function ApprovalCard({ item }: { item: InteractiveItem }) {
  if (item.frame.type !== "approval/requested") return null;
  return (
    <div className="approve">
      <div className="t">需要审批：<b>{item.frame.toolName}</b></div>
      {item.frame.reason && <div className="d">{item.frame.reason}</div>}
      <div className="row">
        <button className="btn primary" onClick={() => void appStore.answerApproval(item, "allowed-once")}>允许一次</button>
        <button className="btn danger-o" onClick={() => void appStore.answerApproval(item, "rejected")}>拒绝</button>
      </div>
    </div>
  );
}

export function QuestionCard({ item }: { item: InteractiveItem }) {
  const [answer, setAnswer] = useState("");
  return (
    <div className="approve">
      <div className="t">提问</div>
      <div className="d">{JSON.stringify(item.frame).slice(0, 300)}</div>
      <div className="row">
        <input className="grow" value={answer} onChange={(e) => setAnswer(e.currentTarget.value)} placeholder="回答" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "7px 10px" }} />
        <button className="btn primary" disabled={!answer.trim()} onClick={() => { void appStore.answerQuestion(item, answer.trim()); setAnswer(""); }}>
          提交
        </button>
      </div>
    </div>
  );
}

export function useConversationItems() {
  const { selectedSessionId, history, live } = useAppState();
  return useMemo(
    () => normalizeConversation(mergeItems(history, live, selectedSessionId)),
    [history, live, selectedSessionId],
  );
}

export function useSessionInteractives() {
  const { selectedSessionId, interactives } = useAppState();
  return useMemo(() => interactives.filter((i) => i.sessionId === selectedSessionId), [interactives, selectedSessionId]);
}

/** 当前会话正在流式生成的回复快照（来自 store.streams）。 */
export function useLiveAssistant(): LiveStream | null {
  const { selectedSessionId, streams } = useAppState();
  return useMemo(() => {
    if (!selectedSessionId) return null;
    const s = streams.get(selectedSessionId);
    if (!s || s.finished || (!s.text && !s.reasoning)) return null;
    return s;
  }, [selectedSessionId, streams]);
}

/** 流式回复行：思考过程展开 + 文本实时累积 + 闪烁光标。 */
export function LiveAssistantRow() {
  const stream = useLiveAssistant();
  if (!stream) return null;
  return (
    <div className="msg-ai live">
      <div className="msg-time">生成中…</div>
      {stream.reasoning && (
        <details className="reasoning-details" open={!stream.text}>
          <summary>思考过程</summary>
          <div className="reasoning-body">{stream.reasoning}</div>
        </details>
      )}
      {stream.text ? <Markdown text={stream.text} /> : <span className="stream-cursor">▍</span>}
      {stream.text && <span className="stream-cursor">▍</span>}
    </div>
  );
}

export { shortId };
