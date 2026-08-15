import { computeRevertInfo } from "../src/lib/dsh/revert.ts";
import { deriveEventMessage } from "@deepseek-ai/dsh-session/surface";

// Fixture: a session with two turns.
// turn1: user "first" -> assistant "A1"
// turn2: user "second" -> tool result (file edit) -> assistant "A2"
const events = [
  { seq: 1, event: { type: "user/message", seq: 1 }, view: undefined },
  { seq: 2, event: { type: "assistant/message", seq: 2 }, view: undefined },
  { seq: 3, event: { type: "turn/end", seq: 3 }, view: undefined },
  { seq: 4, event: { type: "user/message", seq: 4 }, view: undefined },
  { seq: 5, event: { type: "assistant/message", seq: 5 }, view: undefined },
  {
    seq: 6,
    event: { type: "tool/result", seq: 6 },
    view: { view: { diffs: [{ path: "a.txt", oldText: "old", newText: "new" }, { path: "b.txt", oldText: null, newText: "fresh" }] } },
  },
  { seq: 7, event: { type: "assistant/message", seq: 7 }, view: undefined },
  { seq: 8, event: { type: "turn/end", seq: 8 }, view: undefined },
];

const cases: Array<{ name: string; pass: boolean; detail: string }> = [];

// Item 11: retract message seq=4 should anchor at turn boundary 3 (before turn2)
{
  const info = computeRevertInfo(events as never, 4);
  cases.push({
    name: "retract boundary = prevTurnEnd before target message",
    pass: info.prevTurnEnd === 3,
    detail: `prevTurnEnd=${info.prevTurnEnd}`,
  });
}

// Item 10: retry message seq=4 -> fork at 3; derive message surface from seed prefix [1..3]
{
  const info = computeRevertInfo(events as never, 4);
  const seed = events.filter((e) => e.seq <= (info.prevTurnEnd ?? 0));
  // deriveEventMessage needs real event data; here we only check the boundary excludes seq 4
  cases.push({
    name: "retry seed prefix excludes the retried user message",
    pass: seed.every((e) => e.seq !== 4) && seed.some((e) => e.seq === 1),
    detail: `seedSeqs=${seed.map((e) => e.seq).join(",")}`,
  });
}

// Retract collects only the target turn's diffs (seq 6 -> files a.txt, b.txt), not other turns
{
  const info = computeRevertInfo(events as never, 4);
  cases.push({
    name: "retract collects diffs of the target turn only",
    pass: info.files.length === 2 && info.files.some((f) => f.path === "a.txt" && f.diffs.length === 1) && info.files.some((f) => f.path === "b.txt" && f.diffs.length === 1),
    detail: JSON.stringify(info.files.map((f) => ({ path: f.path, n: f.diffs.length }))),
  });
}

// First message: no previous turn boundary
{
  const info = computeRevertInfo(events as never, 1);
  cases.push({
    name: "first message has no revert boundary",
    pass: info.prevTurnEnd === null && info.files.length === 0,
    detail: `prevTurnEnd=${info.prevTurnEnd}`,
  });
}

// deriveEventMessage: empty assistant/message -> null (official rule, item 9 basis)
{
  const empty = { type: "assistant/message", seq: 99, time: 1, data: { message: { role: "assistant", content: [] } } };
  const d = deriveEventMessage(empty as never);
  cases.push({
    name: "deriveEventMessage suppresses empty assistant/message",
    pass: d === null,
    detail: `derived=${String(d)}`,
  });
}

let failed = 0;
for (const c of cases) {
  if (!c.pass) failed++;
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  | " + c.detail : ""}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
