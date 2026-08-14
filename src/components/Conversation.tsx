import { useMemo, useState } from "react";
import { appStore, useAppState, type InteractiveItem } from "../lib/dsh/store";
import { formatTime, shortId } from "./ui";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

interface HistoryEntryLike {
  seq: number;
  event: { type: string; seq: number; time: number; data: Record<string, unknown> };
  view?: unknown;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && (b as { type?: string }).type === "text"
          ? String((b as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
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

function UserMessage({ text, time, sessionId }: { text: string; time: number; sessionId?: SessionId }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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
        {text || "(空)"}
      </div>
      {menu && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 150 }} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="model-menu" style={{ left: menu.x, top: menu.y, right: "auto", bottom: "auto", minWidth: 140, zIndex: 151 }}>
            <button className="mm-item" onClick={() => { void navigator.clipboard.writeText(text).catch(() => {}); setMenu(null); }}>复制</button>
            <button className="mm-item" onClick={() => { if (sessionId) void appStore.sendPrompt(sessionId, text); setMenu(null); }}>重试</button>
            <button className="mm-item" onClick={() => { appStore.set({ error: "dsh 暂不支持撤回已发送消息；可继续对话或使用会话菜单归档" }); setMenu(null); }}>撤回（暂不支持）</button>
          </div>
        </>
      )}
    </>
  );
}

export function EventRow({ item, sessionId }: { item: HistoryEntryLike; sessionId?: SessionId }) {
  const ev = item.event;
  switch (ev.type) {
    case "user/message": {
      const text = contentText(ev.data?.content);
      return <UserMessage text={text || "(空)"} time={ev.time} sessionId={sessionId} />;
    }
    case "assistant/message": {
      // dsh 的 assistant/message 结构为 { turn, step, message: { content: [...] } }
      const data = ev.data as { message?: { content?: unknown }; content?: unknown };
      const text = contentText(data?.message?.content ?? data?.content);
      return (
        <div className="msg-ai">
          <div className="msg-time">{formatTime(ev.time)}</div>
          {text || "(模型未返回文本内容)"}
        </div>
      );
    }
    case "assistant/chunk":
    case "session/title":
    case "turn/start":
    case "step/start":
    case "llm/retry-started":
      return null;
    case "tool/call":
    case "tool/result":
      return (
        <div className="toolcall mono" title={ev.type}>
          {ev.type}: {JSON.stringify(ev.data).slice(0, 500)}
        </div>
      );
    case "turn/end":
    case "step/end": {
      const reason = (ev.data as { reason?: { kind?: string } })?.reason?.kind;
      if (reason === "error") {
        const raw = JSON.stringify(ev.data);
        return <div className="toolcall toolcall-err" title={`${ev.type} @${ev.seq}`}>{ev.type} @{ev.seq}: {raw.slice(0, 600)}</div>;
      }
      return null;
    }
    default: {
      const raw = JSON.stringify(ev.data);
      const isError =
        ev.type.toLowerCase().includes("error") ||
        ev.type.toLowerCase().includes("llm/") ||
        raw.includes("TRANSPORT") ||
        raw.includes("Connection error") ||
        raw.includes("MISSING_CREDENTIAL");
      return (
        <div className={`toolcall${isError ? " toolcall-err" : ""}`} title={`${ev.type} @${ev.seq}`}>
          {ev.type} @{ev.seq}: {raw.slice(0, 600)}
        </div>
      );
    }
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
  return useMemo(() => mergeItems(history, live, selectedSessionId), [history, live, selectedSessionId]);
}

export function useSessionInteractives() {
  const { selectedSessionId, interactives } = useAppState();
  return useMemo(() => interactives.filter((i) => i.sessionId === selectedSessionId), [interactives, selectedSessionId]);
}

export { shortId };








