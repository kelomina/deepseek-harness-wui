/**
 * devContext item 1: 工具视图数据收集器（纯函数，可独立测试）。
 * 数据源与锁定 dsh 0.1.0-rc.6 官方类型契约一致：
 * diff: DiffResultView/FileDiff；terminal: TerminalCallView/TerminalResultView；
 * file: ReadResultView；web: WebSearchResultView/WebFetchResultView。
 */
import type { ToolEventView } from "@deepseek-ai/dsh-host-apiproxy/api";
import type {
  DiffResultView,
  ReadResultView,
  TerminalResultView,
  WebFetchResultView,
  WebSearchResultView,
  WebSource,
} from "@deepseek-ai/dsh-tools/presentation";
import type { RenderItem } from "./render";

export interface FileItem { path: string; kind: "read" | "diff" }
export interface TermItem { cmd: string; cwd?: string; output?: string; exitCode?: number; signal?: string }
export interface DiffGroup { path: string; added: number; deleted: number; hunks: Array<{ oldText: string | null; newText: string }> }
export interface WebItem {
  kind: "search" | "fetch";
  title?: string;
  sources?: WebSource[];
  url?: string;
  statusCode?: number;
  truncated?: boolean;
}

function innerView(item: RenderItem): ToolEventView["view"] | null {
  const v = item.view as ToolEventView | undefined;
  return v?.view ?? null;
}

export function collectFiles(items: RenderItem[]): FileItem[] {
  const out: FileItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const v = innerView(it);
    if (!v) continue;
    if (v.card === "read") {
      const p = (v as ReadResultView).path;
      if (p && !seen.has(`r${p}`)) { seen.add(`r${p}`); out.push({ path: p, kind: "read" }); }
    } else if (v.card === "diff") {
      for (const d of (v as DiffResultView).diffs) {
        if (!seen.has(`d${d.path}`)) { seen.add(`d${d.path}`); out.push({ path: d.path, kind: "diff" }); }
      }
    }
  }
  return out;
}

export function collectTerminals(items: RenderItem[]): TermItem[] {
  const out: TermItem[] = [];
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const v = innerView(it);
    if (!v || v.card !== "terminal") continue;
    const t = v as TerminalResultView;
    const title = t.title ?? "";
    if (!title) continue;
    out.push({ cmd: title, cwd: (v as { cwd?: string }).cwd, output: t.output, exitCode: t.exitCode, signal: t.signal });
  }
  return out;
}

export function collectWeb(items: RenderItem[]): WebItem[] {
  const out: WebItem[] = [];
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const v = innerView(it);
    if (!v || v.card !== "web") continue;
    if ((v as WebSearchResultView | WebFetchResultView).kind === "search") {
      const s = v as WebSearchResultView;
      out.push({ kind: "search", title: s.title, sources: s.sources, truncated: s.truncated });
    } else {
      const f = v as WebFetchResultView;
      out.push({ kind: "fetch", title: f.title, url: f.url, statusCode: f.statusCode, truncated: f.truncated });
    }
  }
  return out;
}

export function collectDiffs(items: RenderItem[]): DiffGroup[] {
  const byPath = new Map<string, DiffGroup>();
  const seen = new Set<string>();
  for (const it of items) {
    if (it.kind !== "tool") continue;
    const v = innerView(it);
    if (!v || v.card !== "diff") continue;
    for (const d of (v as DiffResultView).diffs) {
      const key = `${d.path}\u0000${d.oldText ?? ""}\u0000${d.newText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const g = byPath.get(d.path) ?? { path: d.path, added: 0, deleted: 0, hunks: [] };
      g.added += d.newText.split("\n").length;
      g.deleted += d.oldText ? d.oldText.split("\n").length : 0;
      g.hunks.push({ oldText: d.oldText, newText: d.newText });
      byPath.set(d.path, g);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
