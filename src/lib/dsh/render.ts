/**
 * Conversation surface normalization.
 *
 * Implements devContext items 8/9 against the pinned dsh 0.1.0-rc.6 type
 * contract:
 *  - `assistant/message` with empty content is suppressed (official rule:
 *    `deriveEventMessage` from @deepseek-ai/dsh-session/surface).
 *  - A thinking-only `assistant/message` (reasoning blocks, no text) is NOT
 *    rendered as an empty message; its reasoning is merged into the next
 *    text-bearing assistant message of the same turn.
 *  - If a turn ends with pending reasoning and no text message exists, the
 *    reasoning is attached to the last tool card of that turn (or emitted as
 *    a compact info block) — never as an empty message bubble.
 *  - tool/call and tool/result rows keep their host-computed ToolEventView
 *    for the official 1:1 card rendering (see ToolCards.tsx).
 */
import type { SessionEvent } from "@deepseek-ai/dsh-session/types";
import { deriveEventMessage } from "@deepseek-ai/dsh-session/surface";

export type RenderItemKind = "user" | "assistant" | "tool" | "error" | "info";

export interface RenderItem {
  seq: number;
  time: number;
  kind: RenderItemKind;
  event: SessionEvent & { seq: number; time: number };
  /** Host-computed ToolEventView ({for, view}) when present. */
  view?: unknown;
  /** Merged reasoning (own + earlier suppressed thinking) for an assistant row. */
  reasoning?: string;
  /** Assistant text content. */
  text?: string;
  /** User text content. */
  userText?: string;
  /** Reasoning flushed at turn end that had no following text message. */
  turnReasoning?: string;
  /** Error text for error rows. */
  errorText?: string;
}

interface RawItem {
  seq: number;
  event: { type: string; seq: number; time: number; data: unknown };
  view?: unknown;
}

interface ContentBlockLike {
  type?: string;
  text?: string;
  thinking?: string;
}

function blocksOf(content: unknown): ContentBlockLike[] {
  return Array.isArray(content) ? (content as ContentBlockLike[]) : [];
}

function extractReasoning(blocks: ContentBlockLike[]): string {
  return blocks
    .filter((b) => b.type === "reasoning" || b.type === "thinking")
    .map((b) => b.text ?? b.thinking ?? "")
    .join("\n");
}

function extractText(blocks: ContentBlockLike[]): string {
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

function contentTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  return extractText(blocksOf(content));
}

interface UserMessageLike {
  content?: unknown;
  message?: { content?: unknown };
  source?: { kind?: string };
}

/**
 * Normalize raw history/live items into render items implementing the
 * empty-message merge rule.
 */
export function normalizeConversation(raw: RawItem[]): RenderItem[] {
  const out: RenderItem[] = [];
  let pendingReasoning: string[] = [];
  let turnStartIndex = 0; // index in `out` where the current turn's items begin

  const flushPending = () => {
    const joined = pendingReasoning.join("\n").trim();
    pendingReasoning = [];
    if (!joined) return;
    // Attach to the last tool card of this turn (search only within this turn).
    for (let i = out.length - 1; i >= turnStartIndex; i--) {
      if (out[i].kind === "tool") {
        out[i] = { ...out[i], turnReasoning: joined };
        return;
      }
    }
    // No tool card: emit a compact reasoning info block (has content, not an
    // empty message).
    const last = out.length > 0 ? out[out.length - 1] : null;
    const seq = last ? last.seq + 1 : 0;
    const time = last?.time ?? Date.now();
    out.push({
      seq,
      time,
      kind: "info",
      event: { type: "turn/end", seq, time, data: { reason: { kind: "completed" } } } as SessionEvent & { seq: number; time: number },
      reasoning: joined,
    });
  };

  for (const item of raw) {
    const ev = item.event as SessionEvent & { seq: number; time: number };
    switch (ev.type) {
      case "turn/start": {
        pendingReasoning = [];
        turnStartIndex = out.length;
        break;
      }
      case "user/message": {
        flushPending();
        const derived = deriveEventMessage(ev as never);
        const data = (derived ?? ev.data) as UserMessageLike | null;
        const sourceKind = data?.source?.kind ?? (ev.data as { source?: { kind?: string } })?.source?.kind;
        // dsh 注入的系统上下文（系统提示词快照、skill catalog、AGENTS.md）不渲染为真实用户消息
        if (sourceKind && sourceKind !== "user") {
          pendingReasoning = [];
          turnStartIndex = out.length;
          break;
        }
        const text = contentTextOf(data?.content ?? data?.message?.content ?? ev.data);
        out.push({ seq: ev.seq, time: ev.time, kind: "user", event: ev, userText: text || "(空)" });
        pendingReasoning = [];
        turnStartIndex = out.length;
        break;
      }
      case "assistant/message": {
        const derived = deriveEventMessage(ev as never);
        const msg = derived && typeof derived === "object" && "content" in derived ? (derived as { content?: unknown }) : null;
        if (!msg) {
          // Empty-content assistant/message: official rule skips it.
          break;
        }
        const blocks = blocksOf(msg.content);
        const reasoning = extractReasoning(blocks);
        const text = extractText(blocks);
        if (text) {
          const merged = [...pendingReasoning, reasoning].filter(Boolean).join("\n").trim();
          out.push({ seq: ev.seq, time: ev.time, kind: "assistant", event: ev, reasoning: merged || undefined, text });
          pendingReasoning = [];
        } else if (reasoning) {
          // 仅思考的 assistant/message：不渲染空消息，思考合并到下一条有文本的消息
          pendingReasoning.push(reasoning);
        }
        break;
      }
      case "tool/call":
      case "tool/result": {
        out.push({ seq: ev.seq, time: ev.time, kind: "tool", event: ev, view: item.view });
        break;
      }
      case "turn/end": {
        const reason = (ev.data as { reason?: { kind?: string } })?.reason?.kind;
        if (reason === "error") {
          out.push({ seq: ev.seq, time: ev.time, kind: "error", event: ev, errorText: JSON.stringify(ev.data) });
        }
        flushPending();
        break;
      }
      default:
        break;
    }
  }
  flushPending();
  return out;
}
