import { useMemo, useState } from "react";
import { appStore, useAppState, type InteractiveItem } from "../lib/dsh/store";
import { formatTime, shortId } from "./ui";

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
  for (const h of (history.get(sessionId) ?? []) as HistoryEntryLike[]) map.set(h.seq, h);
  for (const f of (live.get(sessionId) ?? []) as Array<{ type: string; event: HistoryEntryLike["event"]; view?: unknown }>) {
    if (f.type === "session/event") {
      map.set(f.event.seq, { seq: f.event.seq, event: f.event, view: f.view });
    }
  }
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

export function EventRow({ item }: { item: HistoryEntryLike }) {
  const ev = item.event;
  switch (ev.type) {
    case "user/message": {
      const text = contentText(ev.data?.content);
      return (
        <div className="msg-user">
          <div className="msg-time">{formatTime(ev.time)}</div>
          {text || "(空)"}
        </div>
      );
    }
    case "assistant/message": {
      const text = contentText(ev.data?.content);
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
    case "turn/end":
      return null;
    case "tool/call":
    case "tool/result":
      return (
        <div className="toolcall mono" title={ev.type}>
          {ev.type}: {JSON.stringify(ev.data).slice(0, 500)}
        </div>
      );
    default: {
      const raw = JSON.stringify(ev.data);
      const isError =
        ev.type.toLowerCase().includes("error") ||
        ev.type.toLowerCase().includes("llm/") ||
        ev.type === "turn/end" ||
        ev.type === "step/end" ||
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


