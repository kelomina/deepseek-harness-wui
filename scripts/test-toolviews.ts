import { collectDiffs, collectFiles, collectTerminals, collectWeb } from "../src/lib/dsh/toolCollect.ts";

// Build RenderItem-like tool items with official presentation views
function toolItem(seq: number, view: unknown) {
  return { seq, time: 1, kind: "tool" as const, event: { type: "tool/result", seq, time: 1, data: {} }, view };
}

const items = [
  toolItem(1, { for: "result", view: { card: "terminal", title: "npm test", output: "PASS", exitCode: 0, cwd: "/repo" } }),
  toolItem(2, { for: "result", view: { card: "read", path: "src/a.ts", offset: 1, lines: [{ number: 1, text: "hi" }], totalLines: 10, lang: "ts" } }),
  toolItem(3, { for: "result", view: { card: "diff", title: "Write src/a.ts", diffs: [{ path: "src/a.ts", oldText: "old", newText: "new\nline2" }] } }),
  toolItem(4, { for: "result", view: { card: "web", kind: "search", title: "web search", sources: [{ url: "https://x", title: "X" }], truncated: false } }),
  toolItem(5, { for: "result", view: { card: "web", kind: "fetch", title: "fetch", url: "https://y", statusCode: 404, truncated: true } }),
];

const cases: Array<{ name: string; pass: boolean; detail: string }> = [];

{
  const terms = collectTerminals(items as never);
  cases.push({ name: "terminal collector", pass: terms.length === 1 && terms[0].cmd === "npm test" && terms[0].exitCode === 0, detail: JSON.stringify(terms) });
}
{
  const files = collectFiles(items as never);
  cases.push({
    name: "file collector (read + diff paths, dedup)",
    pass: files.length === 2 && files.some((f) => f.path === "src/a.ts" && f.kind === "read") && files.some((f) => f.path === "src/a.ts" && f.kind === "diff"),
    detail: JSON.stringify(files),
  });
}
{
  const diffs = collectDiffs(items as never);
  cases.push({
    name: "diff collector groups by path with stats",
    pass: diffs.length === 1 && diffs[0].path === "src/a.ts" && diffs[0].added === 2 && diffs[0].deleted === 1,
    detail: JSON.stringify(diffs),
  });
}
{
  const web = collectWeb(items as never);
  cases.push({
    name: "web collector (search + fetch)",
    pass: web.length === 2 && web[0].kind === "search" && web[0].sources?.length === 1 && web[1].kind === "fetch" && web[1].statusCode === 404,
    detail: JSON.stringify(web),
  });
}
{
  // 非工具项与未知 card 不产生记录
  const mixed = [
    { seq: 6, time: 1, kind: "assistant" as const, event: { type: "assistant/message", seq: 6, time: 1, data: {} }, text: "hi" },
    toolItem(7, { for: "result", view: { card: "generic", title: "generic" } }),
  ];
  const diffs2 = collectDiffs(mixed as never);
  const terms2 = collectTerminals(mixed as never);
  cases.push({
    name: "non-tool/generic items excluded",
    pass: diffs2.length === 0 && terms2.length === 0,
    detail: `diffs=${diffs2.length} terms=${terms2.length}`,
  });
}

let failed = 0;
for (const c of cases) {
  if (!c.pass) failed++;
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  | " + c.detail : ""}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
