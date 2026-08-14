import { useMemo, useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import { sessionTitle } from "../lib/dsh/sessionTitle";
import { shortId, useConversationItems } from "../components/Conversation";

interface FileDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

interface ChangeFile {
  path: string;
  added: number;
  deleted: number;
  diffs: FileDiff[];
}

type TerminalItem = { cmd: string; output?: string };

function collectChanges(items: Array<{ event: { type: string }; view?: unknown }>): ChangeFile[] {
  const byPath = new Map<string, ChangeFile>();
  const seen = new Set<string>();
  for (const item of items) {
    if (item.event.type !== "tool/call" && item.event.type !== "tool/result") continue;
    const v = item.view as { for?: string; view?: { card?: string; diffs?: FileDiff[] } } | undefined;
    const view = v?.view;
    if (!view || view.card !== "diff" || !Array.isArray(view.diffs)) continue;
    for (const diff of view.diffs) {
      const key = `${diff.path}\u0000${diff.oldText ?? ""}\u0000${diff.newText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const oldLines = diff.oldText ? diff.oldText.split("\n").length : 0;
      const newLines = diff.newText.split("\n").length;
      const cur = byPath.get(diff.path) ?? { path: diff.path, added: 0, deleted: 0, diffs: [] };
      cur.added += newLines;
      cur.deleted += oldLines;
      cur.diffs.push(diff);
      byPath.set(diff.path, cur);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function collectTerminal(items: Array<{ event: { type: string }; view?: unknown }>): TerminalItem[] {
  const out: TerminalItem[] = [];
  for (const item of items) {
    if (item.event.type !== "tool/call" && item.event.type !== "tool/result") continue;
    const v = item.view as { for?: string; view?: { card?: string; title?: string; output?: string; cwd?: string } } | undefined;
    const view = v?.view;
    if (!view || view.card !== "terminal") continue;
    if (view.title) out.push({ cmd: view.cwd ? `${view.title}  # ${view.cwd}` : view.title, output: view.output });
  }
  return out;
}

export function CodeView() {
  const { sessions, selectedSessionId, status, activeWorkspaceId, workspaces, connected } = useAppState();
  const items = useConversationItems();
  const selected = sessions.find((s) => s.sessionId === selectedSessionId);
  const activeWs = workspaces.find((w) => w.workspaceId === activeWorkspaceId) ?? null;

  const changes = useMemo(() => collectChanges(items), [items]);
  const terminals = useMemo(() => collectTerminal(items), [items]);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, "accepted" | "rejected">>({});
  const [chat, setChat] = useState<Array<{ role: "user" | "ai"; text: string }>>([
    { role: "ai", text: "选择左侧 diff 或直接提问，我会结合当前改动回答。" },
  ]);
  const [chatDraft, setChatDraft] = useState("");
  const [termTab, setTermTab] = useState<"terminal" | "problems" | "output">("terminal");

  const file = changes.find((c) => c.path === selectedPath) ?? changes[0] ?? null;
  const totalAdded = changes.reduce((n, c) => n + c.added, 0);
  const totalDeleted = changes.reduce((n, c) => n + c.deleted, 0);

  const sendChat = () => {
    const text = chatDraft.trim();
    if (!text || !selectedSessionId || !connected) return;
    setChat((m) => [...m, { role: "user", text }]);
    setChatDraft("");
    void appStore.sendPrompt(selectedSessionId, text);
  };

  return (
    <section className="view active" id="view-code">
      <div className="col col-code">
        <div className="view-cap">Code 模式 · AIDE（人主导、AI 协作）</div>
        <div className="conv-head">
          <span className="conv-title">{selected ? (sessionTitle(selected) ?? shortId(selected.sessionId)) : "未选择会话"}</span>
          <span className="code-actions">
            <span className="badge gray">Code</span>
            <button className="btn danger-o" disabled={changes.length === 0}>拒绝全部</button>
            <button className="btn primary" disabled={changes.length === 0}>
              接受全部（+{totalAdded} −{totalDeleted}）
            </button>
          </span>
        </div>

        {changes.length === 0 ? (
          <div className="empty-state" style={{ flex: 1 }}>
            当前会话还没有文件变更。在 Work 模式让 AI 读写代码后，这里会显示 diff。
          </div>
        ) : (
          <div className="code-layout">
            {/* 左：变更文件 */}
            <div className="file-pane">
              <div className="pane-title">变更文件</div>
              <div className="file-list">
                {changes.map((c) => (
                  <div
                    key={c.path}
                    className={`file-item${file?.path === c.path ? " active" : ""}`}
                    onClick={() => setSelectedPath(c.path)}
                  >
                    <span className="f-path">{c.path}</span>
                    <span className="f-stat add">+{c.added}</span>
                    {c.deleted > 0 && <span className="f-stat del">-{c.deleted}</span>}
                  </div>
                ))}
              </div>
              <div className="pane-foot">
                {changes.length} 个文件 · +{totalAdded} −{totalDeleted} · {activeWs?.path ? `工作区 ${activeWs.path}` : "本地"}
              </div>
            </div>

            {/* 中：diff 查看器（逐 hunk 接受/拒绝） */}
            <div className="diff-pane">
              {file ? (
                <>
                  <div className="diff-head">
                    <span className="d-path">{file.path}</span>
                    <span className="badge green">已修改</span>
                    <button className="btn sm" title="开发中">打开文件</button>
                    <button className="btn sm" title="开发中">复制 diff</button>
                  </div>
                  <div className="diff-body mono">
                    {file.diffs.map((diff, idx) => {
                      const key = `${file.path}#${idx}`;
                      const decision = decisions[key];
                      const oldLines = diff.oldText ? diff.oldText.split("\n") : [];
                      const newLines = diff.newText.split("\n");
                      return (
                        <div key={key}>
                          {oldLines.map((line, i) => (
                            <div className="diff-line del" key={`o${i}`}>
                              <span className="ln">{i + 1}</span>
                              <span className="code">{line}</span>
                            </div>
                          ))}
                          {newLines.map((line, i) => (
                            <div className="diff-line add" key={`n${i}`}>
                              <span className="ln">{i + 1}</span>
                              <span className="code">{line}</span>
                            </div>
                          ))}
                          <div className="hunk-bar">
                            <span className="hunk-tip">
                              {decision === "accepted" ? "已接受" : decision === "rejected" ? "已拒绝" : `${(oldLines[0] ?? "").trim() || "(新建)"} → ${(newLines[0] ?? "").trim() || ""}`}
                            </span>
                            <button
                              className="btn sm primary"
                              disabled={decision !== undefined}
                              onClick={() => setDecisions((d) => ({ ...d, [key]: "accepted" }))}
                            >
                              接受
                            </button>
                            <button
                              className="btn sm danger-o"
                              disabled={decision !== undefined}
                              onClick={() => setDecisions((d) => ({ ...d, [key]: "rejected" }))}
                            >
                              拒绝
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="empty-state">没有可显示的 diff</div>
              )}
            </div>

            {/* 右：AI 侧聊 */}
            <div className="chat-pane">
              <div className="pane-title">AI 助手 · 针对当前 diff</div>
              <div className="chat-msgs">
                {chat.map((m, i) => (
                  <div key={i} className={`c-msg ${m.role}`}>{m.text}</div>
                ))}
              </div>
              <div className="chat-input">
                <input
                  type="text"
                  placeholder="提问当前 diff…（@ 引用文件）"
                  value={chatDraft}
                  onChange={(e) => setChatDraft(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }}
                />
                <button className="send-btn mini" disabled={!chatDraft.trim()} onClick={sendChat}>↑</button>
              </div>
            </div>
          </div>
        )}

        {/* 底部：终端 + 状态栏 */}
        <div className="term-strip">
          <div className="term-tabs">
            <span className={`t-tab${termTab === "terminal" ? " on" : ""}`} onClick={() => setTermTab("terminal")}>终端</span>
            <span className={`t-tab${termTab === "problems" ? " on" : ""}`} onClick={() => setTermTab("problems")}>问题 (0)</span>
            <span className={`t-tab${termTab === "output" ? " on" : ""}`} onClick={() => setTermTab("output")}>输出</span>
          </div>
          {termTab === "terminal" && (
            <div className="term-line mono">
              {terminals.length === 0 ? "(暂无终端输出)" : terminals.map((t, i) => (
                <div key={i} style={{ whiteSpace: "pre-wrap" }}>
                  <span style={{ color: "#8ab4f8" }}>$ {t.cmd}</span>
                  {t.output ? `\n${t.output}` : ""}
                </div>
              ))}
            </div>
          )}
          {termTab === "problems" && <div className="term-line mono">（问题面板开发中）</div>}
          {termTab === "output" && <div className="term-line mono">（输出面板开发中）</div>}
        </div>
        <div className="status-bar mono">
          <span>⎇ {activeWs?.path ?? "本地"}</span>
          <span>UTF-8</span>
          <span>Ln 1, Col 1</span>
          <span className="ok">● dsh 已连接 :{status?.port ?? "-"}</span>
        </div>
      </div>
    </section>
  );
}
