/**
 * devContext item 1: 文件管理器 / 终端 / 浏览器 / Git 工具视图（MVP）。
 *
 * 数据源与锁定 dsh 0.1.0-rc.6 的官方类型契约一致：
 * - diff：DiffResultView/FileDiff
 * - 终端：TerminalCallView/TerminalResultView
 * - 文件：ReadResultView / host.listDirectory（只读目录浏览）
 * - 路径/匹配：ToolEventView（search 结果）
 * 能力边界：终端/浏览器/Git 为只读视图（记录型），不做交互式 pty / 真实浏览器 / git 操作；
 * 文件管理器为只读目录浏览（dsh browse capability）。宽度 ≤1280 时折叠为浮动开关。
 */
import { useEffect, useMemo, useState } from "react";
import { appStore } from "../lib/dsh/store";
import type { RenderItem } from "../lib/dsh/render";
import { collectDiffs, collectFiles, collectTerminals, collectWeb } from "../lib/dsh/toolCollect";

interface DirEntry { name: string; path: string; hidden: boolean }

function FileBrowserPanel({ root }: { root: string | null }) {
  const [path, setPath] = useState<string | null>(root);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPath(root);
  }, [root]);

  useEffect(() => {
    let alive = true;
    setError(null);
    void appStore.listDirectory(path ?? undefined).then((r) => {
      if (!alive) return;
      if (r.result.ok) {
        setPath(r.result.value.path ?? null);
        setEntries((r.result.value.entries ?? []) as DirEntry[]);
      } else {
        setError(`${r.result.error.code}: ${r.result.error.message}`);
      }
    }).catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [path]);

  const goUp = () => {
    if (!path) return;
    const parent = path.replace(/[\\/]+$/, "");
    const cut = Math.max(parent.lastIndexOf("\\"), parent.lastIndexOf("/"));
    setPath(cut > 0 ? parent.slice(0, cut) : "");
  };

  return (
    <div className="tv-file">
      <div className="tv-cwd mono">{path ?? "加载中…"}</div>
      {error && <div className="toolcall toolcall-err">{error}</div>}
      <div className="tv-list">
        {path && (
          <div className="folder-row" onClick={goUp}><span>📁</span><span className="name">.. (上级)</span></div>
        )}
        {entries.map((d) => (
          <div className="folder-row" key={d.path} onClick={() => setPath(d.path)}>
            <span>📁</span>
            <span className="name">{d.name}</span>
            {d.hidden && <span className="sub">隐藏</span>}
          </div>
        ))}
        {entries.length === 0 && <div className="empty-state">（没有子目录）</div>}
      </div>
    </div>
  );
}

export function ToolViews({ items, workspaceRoot }: { items: RenderItem[]; workspaceRoot: string | null }) {
  const [tab, setTab] = useState<"files" | "terminal" | "web" | "git">("files");
  const [open, setOpen] = useState(true);
  const files = useMemo(() => collectFiles(items), [items]);
  const terminals = useMemo(() => collectTerminals(items), [items]);
  const web = useMemo(() => collectWeb(items), [items]);
  const diffs = useMemo(() => collectDiffs(items), [items]);

  return (
    <div className={`tools-col${open ? " open" : ""}`}>
      <div className="tools-head">
        <span className="tools-title">工具</span>
        <button className="btn sm subtle" onClick={() => setOpen((v) => !v)}>{open ? "收起" : "展开"}</button>
      </div>
      {open && (
        <>
          <div className="tools-tabs">
            <span className={`t-tab${tab === "files" ? " on" : ""}`} onClick={() => setTab("files")}>文件</span>
            <span className={`t-tab${tab === "terminal" ? " on" : ""}`} onClick={() => setTab("terminal")}>终端</span>
            <span className={`t-tab${tab === "web" ? " on" : ""}`} onClick={() => setTab("web")}>浏览器</span>
            <span className={`t-tab${tab === "git" ? " on" : ""}`} onClick={() => setTab("git")}>Git</span>
          </div>
          <div className="tools-body">
            {tab === "files" && (
              <>
                <FileBrowserPanel root={workspaceRoot} />
                <div className="f-label">会话涉及文件</div>
                {files.length === 0 ? (
                  <div className="empty-state">暂无文件记录</div>
                ) : (
                  files.map((f) => (
                    <div className="folder-row" key={`${f.kind}:${f.path}`}>
                      <span>{f.kind === "read" ? "📄" : "✏️"}</span>
                      <span className="name mono">{f.path}</span>
                    </div>
                  ))
                )}
              </>
            )}
            {tab === "terminal" && (
              terminals.length === 0 ? (
                <div className="empty-state">暂无终端记录</div>
              ) : (
                terminals.map((t, i) => (
                  <div className="toolcard" key={i}>
                    <div className="toolcard-head">
                      <span className="toolcard-title mono">$ {t.cmd}</span>
                      {typeof t.exitCode === "number" && <span className={`badge ${t.exitCode === 0 ? "green" : "orange"}`}>exit {t.exitCode}</span>}
                      {t.signal && <span className="badge orange">signal {t.signal}</span>}
                    </div>
                    {t.cwd && <div className="toolcard-cwd mono">{t.cwd}</div>}
                    {t.output != null && <pre className="toolcard-output mono">{t.output}</pre>}
                  </div>
                ))
              )
            )}
            {tab === "web" && (
              web.length === 0 ? (
                <div className="empty-state">暂无 web 记录</div>
              ) : (
                web.map((w, i) => (
                  <div className="toolcard" key={i}>
                    <div className="toolcard-head">
                      <span className="toolcard-title">{w.title ?? (w.kind === "search" ? "网络搜索" : "网页抓取")}</span>
                      {w.kind === "fetch" && typeof w.statusCode === "number" && (
                        <span className={`badge ${w.statusCode >= 200 && w.statusCode < 400 ? "green" : "orange"}`}>HTTP {w.statusCode}</span>
                      )}
                    </div>
                    {w.kind === "search" ? (
                      <div className="toolcard-body">
                        {(w.sources ?? []).map((s, j) => (
                          <div className="web-source" key={j}>
                            <div className="web-source-title">{s.title ?? s.url}</div>
                            {s.url && <div className="web-source-url mono">{s.url}</div>}
                            {s.snippet && <div className="web-source-snippet">{s.snippet}</div>}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="toolcard-body">
                        <div className="toolcard-cwd mono">{w.url}</div>
                        {w.truncated && <div className="toolcard-desc">（内容已截断）</div>}
                      </div>
                    )}
                  </div>
                ))
              )
            )}
            {tab === "git" && (
              diffs.length === 0 ? (
                <div className="empty-state">暂无文件变更</div>
              ) : (
                diffs.map((g) => (
                  <div className="toolcard" key={g.path}>
                    <div className="toolcard-head">
                      <span className="toolcard-title mono">{g.path}</span>
                      <span className="badge green">+{g.added}</span>
                      <span className="badge orange">-{g.deleted}</span>
                    </div>
                    <div className="toolcard-body">
                      {g.hunks.map((h, i) => (
                        <div className="tool-diff" key={i}>
                          {h.oldText && h.oldText.split("\n").map((line, j) => (
                            <div className="diff-line del" key={`o${j}`}><span className="ln">{j + 1}</span><span className="code">{line}</span></div>
                          ))}
                          {h.newText.split("\n").map((line, j) => (
                            <div className="diff-line add" key={`n${j}`}><span className="ln">{j + 1}</span><span className="code">{line}</span></div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}
