/**
 * devContext item 1: 文件管理器 / 终端 / 浏览器 / Git 工具视图。
 *
 * 数据源：
 * - 会话记录型数据与锁定 dsh 0.1.0-rc.6 的官方类型契约一致
 *   （diff: DiffResultView；terminal: TerminalCallView/TerminalResultView；
 *    file: ReadResultView；web: WebSearchResultView/WebFetchResultView）。
 * - 交互式功能经 Tauri Rust 命令直连本机能力（不依赖 dsh capability）：
 *   文件=fs_list_dir 目录浏览；终端=term_exec 命令执行；
 *   浏览器=web_fetch 网页抓取；Git=git_status/git_diff_file/git_stage/git_unstage/git_commit。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RenderItem } from "../lib/dsh/render";
import { collectFiles } from "../lib/dsh/toolCollect";

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
    void invoke<{ path: string; entries: DirEntry[] }>("fs_list_dir", { path: path ?? null })
      .then((r) => {
        if (!alive) return;
        setPath(r.path || null);
        setEntries(r.entries ?? []);
      })
      .catch((e) => { if (alive) setError(String(e)); });
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

/* ===== 终端：真实命令执行 ===== */
interface TermRecord { cmd: string; cwd: string; output: string; exitCode: number | null }

function TerminalPanel({ root }: { root: string | null }) {
  const [cmd, setCmd] = useState("");
  const [cwd, setCwd] = useState(root ?? "");
  const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<TermRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (root) setCwd((v) => (v ? v : root));
  }, [root]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [records]);

  const run = async () => {
    const c = cmd.trim();
    if (!c || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await invoke<{ output: string; exit_code: number | null }>("term_exec", {
        cmd: c,
        cwd: cwd.trim() || null,
      });
      setRecords((rs) => [...rs, { cmd: c, cwd: cwd.trim() || "~", output: r.output, exitCode: r.exit_code }]);
      setCmd("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tp-wrap">
      <div className="tp-input-row">
        <span className="tp-prompt mono">$</span>
        <input
          className="input tp-cmd"
          placeholder="输入命令，Enter 执行"
          value={cmd}
          onChange={(e) => setCmd(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
        />
        <button className="btn sm primary" disabled={busy || !cmd.trim()} onClick={() => void run()}>
          {busy ? "执行中…" : "执行"}
        </button>
      </div>
      <div className="tp-input-row">
        <span className="tp-prompt mono">cwd</span>
        <input
          className="input tp-cwd"
          placeholder="工作目录（空=主目录）"
          value={cwd}
          onChange={(e) => setCwd(e.currentTarget.value)}
        />
      </div>
      {error && <div className="toolcall toolcall-err">{error}</div>}
      <div className="tp-records" ref={listRef}>
        {records.length === 0 && <div className="empty-state">尚未执行任何命令</div>}
        {records.map((r, i) => (
          <div className="toolcard" key={i}>
            <div className="toolcard-head">
              <span className="toolcard-title mono">$ {r.cmd}</span>
              {r.exitCode != null && (
                <span className={`badge ${r.exitCode === 0 ? "green" : "orange"}`}>exit {r.exitCode}</span>
              )}
            </div>
            <div className="toolcard-cwd mono">{r.cwd}</div>
            <pre className="toolcard-output mono">{r.output || "（无输出）"}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===== 浏览器：真实网页抓取 ===== */
interface WebRecord { url: string; status: number; body: string; expanded: boolean }

function WebPanel() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<WebRecord[]>([]);

  const fetchUrl = async () => {
    const u = url.trim();
    if (!u || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await invoke<{ status: number; body: string }>("web_fetch", { url: u });
      setRecords((rs) => [{ url: u, status: r.status, body: r.body, expanded: true }, ...rs]);
      setUrl("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tp-wrap">
      <div className="tp-input-row">
        <span className="tp-prompt mono">URL</span>
        <input
          className="input tp-cmd"
          placeholder="https://example.com"
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void fetchUrl(); }}
        />
        <button className="btn sm primary" disabled={busy || !url.trim()} onClick={() => void fetchUrl()}>
          {busy ? "抓取中…" : "抓取"}
        </button>
      </div>
      {error && <div className="toolcall toolcall-err">{error}</div>}
      <div className="tp-records">
        {records.length === 0 && <div className="empty-state">尚未抓取任何网页</div>}
        {records.map((r, i) => (
          <div className="toolcard" key={i}>
            <div className="toolcard-head">
              <span className="toolcard-title mono">{r.url}</span>
              <span className={`badge ${r.status >= 200 && r.status < 400 ? "green" : "orange"}`}>HTTP {r.status}</span>
              <button
                className="btn sm subtle"
                onClick={() =>
                  setRecords((rs) => rs.map((x, j) => (j === i ? { ...x, expanded: !x.expanded } : x)))
                }
              >
                {r.expanded ? "收起" : "展开"}
              </button>
            </div>
            {r.expanded && <pre className="toolcard-output mono">{r.body || "（空响应）"}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===== Git：真实 git 操作 ===== */
interface GitFile { path: string; staged: string; unstaged: string }

function GitPanel({ root }: { root: string | null }) {
  const [repo, setRepo] = useState(root ?? "");
  const [files, setFiles] = useState<GitFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (root) setRepo((v) => (v ? v : root));
  }, [root]);

  const refresh = async (r?: string) => {
    const target = (r ?? repo).trim();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const list = await invoke<GitFile[]>("git_status", { root: target });
      setFiles(list);
      setDiff(null);
    } catch (e) {
      setError(String(e));
      setFiles([]);
    } finally {
      setBusy(false);
    }
  };

  const showDiff = async (f: GitFile) => {
    const staged = f.staged !== " " && f.staged !== "?" && f.staged !== "U";
    try {
      const text = await invoke<string>("git_diff_file", { root: repo.trim(), path: f.path, staged });
      setDiff({ path: f.path, text });
    } catch (e) {
      setError(String(e));
    }
  };

  const act = async (fn: () => Promise<string>, okMsg: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const out = await fn();
      setNotice(out.trim() || okMsg);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusChar = (f: GitFile) => {
    if (f.staged === "?" || f.unstaged === "?") return "?";
    if (f.staged !== " ") return f.staged;
    return f.unstaged;
  };

  return (
    <div className="tp-wrap">
      <div className="tp-input-row">
        <span className="tp-prompt mono">repo</span>
        <input
          className="input tp-cmd"
          placeholder="仓库根目录（如 e:\Project\xxx）"
          value={repo}
          onChange={(e) => setRepo(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void refresh(); }}
        />
        <button className="btn sm primary" disabled={busy || !repo.trim()} onClick={() => void refresh()}>
          {busy ? "刷新中…" : "刷新"}
        </button>
      </div>
      {error && <div className="toolcall toolcall-err">{error}</div>}
      {notice && <div className="hint" style={{ color: "var(--green)" }}>{notice}</div>}
      <div className="tp-records">
        {files.length === 0 && <div className="empty-state">工作区干净，或目录不是 git 仓库</div>}
        {files.map((f) => (
          <div className="toolcard" key={f.path}>
            <div className="toolcard-head">
              <span className="badge">{statusChar(f)}</span>
              <span className="toolcard-title mono">{f.path}</span>
              <button className="btn sm" onClick={() => void showDiff(f)}>diff</button>
              {f.staged === " " ? (
                <button className="btn sm" disabled={busy} onClick={() => void act(() => invoke<string>("git_stage", { root: repo.trim(), path: f.path }), "已暂存")}>
                  暂存
                </button>
              ) : (
                <button className="btn sm" disabled={busy} onClick={() => void act(() => invoke<string>("git_unstage", { root: repo.trim(), path: f.path }), "已取消暂存")}>
                  取消暂存
                </button>
              )}
            </div>
            {diff?.path === f.path && (
              <pre className="toolcard-output mono">{diff.text || "（无差异内容）"}</pre>
            )}
          </div>
        ))}
      </div>
      {files.some((f) => f.staged !== " ") && (
        <div className="tp-commit-row">
          <input
            className="input"
            placeholder="提交信息"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.currentTarget.value)}
          />
          <button
            className="btn sm primary"
            disabled={busy || !commitMsg.trim()}
            onClick={() => void act(() => invoke<string>("git_commit", { root: repo.trim(), message: commitMsg }), "提交完成")}
          >
            提交
          </button>
        </div>
      )}
    </div>
  );
}

export function ToolViews({
  items,
  workspaceRoot,
  initialTab = "files",
  onTabChange,
  showToggle = true,
  startOpen = true,
  compact = false,
}: {
  items: RenderItem[];
  workspaceRoot: string | null;
  initialTab?: "files" | "terminal" | "web" | "git";
  onTabChange?: (tab: "files" | "terminal" | "web" | "git") => void;
  showToggle?: boolean;
  startOpen?: boolean;
  /** 紧凑模式：隐藏内部「工具」标题栏与 tab 栏（由外部容器提供 tab 时使用） */
  compact?: boolean;
}) {
  const [tab, setTab] = useState<"files" | "terminal" | "web" | "git">(initialTab);
  const [open, setOpen] = useState(startOpen);
  const files = useMemo(() => collectFiles(items), [items]);

  const changeTab = (t: "files" | "terminal" | "web" | "git") => {
    setTab(t);
    onTabChange?.(t);
  };

  return (
    <div className={`tools-col${open ? " open" : ""}${compact ? " compact" : ""}`}>
      {!compact && (
        <div className="tools-head">
          <span className="tools-title">工具</span>
          {showToggle && (
            <button className="btn sm subtle" onClick={() => setOpen((v) => !v)}>
              {open ? "收起" : "展开"}
            </button>
          )}
        </div>
      )}
      {open && (
        <>
          {!compact && (
            <div className="tools-tabs">
              <span className={`t-tab${tab === "files" ? " on" : ""}`} onClick={() => changeTab("files")}>文件</span>
              <span className={`t-tab${tab === "terminal" ? " on" : ""}`} onClick={() => changeTab("terminal")}>终端</span>
              <span className={`t-tab${tab === "web" ? " on" : ""}`} onClick={() => changeTab("web")}>浏览器</span>
              <span className={`t-tab${tab === "git" ? " on" : ""}`} onClick={() => changeTab("git")}>Git</span>
            </div>
          )}
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
            {tab === "terminal" && <TerminalPanel root={workspaceRoot} />}
            {tab === "web" && <WebPanel />}
            {tab === "git" && <GitPanel root={workspaceRoot} />}
          </div>
        </>
      )}
    </div>
  );
}
