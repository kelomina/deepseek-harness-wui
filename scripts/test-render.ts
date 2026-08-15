import { normalizeConversation } from "../src/lib/dsh/render.ts";

function ev(type: string, seq: number, data: unknown, extra: Record<string, unknown> = {}) {
  return { type, seq, time: 1700000000000 + seq, data, ...extra };
}

const cases: Array<{ name: string; pass: boolean; detail: string }> = [];

// Case 1: empty assistant/message (max-tokens usage host) is suppressed
{
  const raw = [
    { seq: 1, event: ev("user/message", 1, { role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }) },
    { seq: 2, event: ev("assistant/message", 2, { message: { role: "assistant", content: [] } }) }, // empty
    { seq: 3, event: ev("assistant/message", 3, { message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }) },
    { seq: 4, event: ev("turn/end", 4, { reason: { kind: "completed" } }) },
  ];
  const out = normalizeConversation(raw);
  const kinds = out.map((i) => i.kind);
  cases.push({ name: "empty assistant suppressed", pass: !out.some((i) => i.kind === "assistant" && !i.text), detail: JSON.stringify(kinds) });
  cases.push({ name: "text assistant kept", pass: out.some((i) => i.kind === "assistant" && i.text === "hello"), detail: "" });
}

// Case 2: thinking-only assistant/message merged into next text message
{
  const raw = [
    { seq: 1, event: ev("user/message", 1, { role: "user", content: [{ type: "text", text: "q" }], source: { kind: "user" } }) },
    { seq: 2, event: ev("assistant/message", 2, { message: { role: "assistant", content: [{ type: "reasoning", text: "think-1" }] } }) },
    { seq: 3, event: ev("tool/call", 3, { toolName: "bash", args: {} }), view: { for: "call", view: { card: "terminal", title: "ls" } } },
    { seq: 4, event: ev("tool/result", 4, { message: { role: "tool", content: [{ type: "text", text: "out" }] } }), view: { for: "result", view: { card: "terminal", title: "ls", output: "out", exitCode: 0 } } },
    { seq: 5, event: ev("assistant/message", 5, { message: { role: "assistant", content: [{ type: "reasoning", text: "think-2" }, { type: "text", text: "answer" }] } }) },
    { seq: 6, event: ev("turn/end", 6, { reason: { kind: "completed" } }) },
  ];
  const out = normalizeConversation(raw);
  const assistant = out.find((i) => i.kind === "assistant");
  cases.push({
    name: "thinking merged into next text message",
    pass: assistant !== undefined && assistant.text === "answer" && (assistant.reasoning ?? "").includes("think-1") && (assistant.reasoning ?? "").includes("think-2"),
    detail: assistant ? JSON.stringify({ text: assistant.text, reasoning: assistant.reasoning }) : "no assistant",
  });
  const tools = out.filter((i) => i.kind === "tool");
  const tv = tools[0]?.view as { view?: { card?: string } } | undefined;
  cases.push({ name: "tool events kept with view", pass: tools.length === 2 && tv?.view?.card === "terminal", detail: JSON.stringify(tools.map((t) => ((t.view as { view?: { card?: string } })?.view?.card))) });
  cases.push({ name: "no empty assistant row", pass: !out.some((i) => i.kind === "assistant" && !i.text), detail: JSON.stringify(out.map((i) => i.kind)) });
}

// Case 3: turn ends with pending reasoning and no text -> reasoning attaches to last tool card
{
  const raw = [
    { seq: 1, event: ev("user/message", 1, { role: "user", content: [{ type: "text", text: "q" }], source: { kind: "user" } }) },
    { seq: 2, event: ev("assistant/message", 2, { message: { role: "assistant", content: [{ type: "reasoning", text: "plan" }] } }) },
    { seq: 3, event: ev("tool/call", 3, { toolName: "bash", args: {} }), view: { for: "call", view: { card: "terminal", title: "ls" } } },
    { seq: 4, event: ev("turn/end", 4, { reason: { kind: "completed" } }) },
  ];
  const out = normalizeConversation(raw);
  const tool = out.find((i) => i.kind === "tool");
  cases.push({
    name: "pending reasoning attaches to last tool card",
    pass: tool !== undefined && (tool.turnReasoning ?? "").includes("plan"),
    detail: tool ? JSON.stringify({ turnReasoning: tool.turnReasoning }) : "no tool",
  });
  cases.push({ name: "no empty message bubble", pass: !out.some((i) => i.kind === "assistant" && !i.text), detail: JSON.stringify(out.map((i) => i.kind)) });
}

// Case 4: injected system context (source.kind != user) suppressed
{
  const raw = [
    { seq: 1, event: ev("user/message", 1, { role: "user", content: [{ type: "text", text: "<system-reminder>" }], source: { kind: "plugin" } }) },
    { seq: 2, event: ev("user/message", 2, { role: "user", content: [{ type: "text", text: "real" }], source: { kind: "user" } }) },
  ];
  const out = normalizeConversation(raw);
  cases.push({
    name: "injected system context suppressed",
    pass: out.filter((i) => i.kind === "user").length === 1 && out.some((i) => i.userText === "real"),
    detail: JSON.stringify(out.map((i) => i.userText)),
  });
}

let failed = 0;
for (const c of cases) {
  if (!c.pass) failed++;
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  | " + c.detail : ""}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
