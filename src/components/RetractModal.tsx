import { useState } from "react";

export interface RevertDiff {
  seq: number;
  oldText: string | null;
  newText: string;
}

export interface RevertInfo {
  prevTurnEnd: number | null;
  files: Array<{ path: string; diffs: RevertDiff[] }>;
}

export function RetractModal({
  info,
  onCancel,
  onMessagesOnly,
  onConfirm,
}: {
  info: RevertInfo;
  onCancel: () => void;
  onMessagesOnly: () => void;
  onConfirm: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const files = info.files;
  const shown = expanded ? files : files.slice(0, 3);
  const selected = files.find((f) => f.path === sel) ?? null;
  return (
    <div className="modal-overlay">
      <div className="modal" style={{ width: "min(680px, calc(100vw - 48px))" }}>
        <header>撤回此消息？</header>
        <div className="modal-body">
          <p style={{ fontSize: 13, color: "var(--text-2)", marginBottom: 12 }}>
            将回退到该消息之前的轮次。
            <br />
            <b>注意（dsh 0.1.0-rc.6 协议限制）</b>：dsh 仅支持 <code>sessions.fork</code> 新建会话，不支持「当前会话内撤回」。
            撤回会在原会话基础上创建<b>新会话</b>并切换到它；原会话保留未动。文件回退会写入磁盘，请确认后再执行。
          </p>
          {files.length > 0 && (
            <div className="list" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 4 }}>
              {shown.map((f) => (
                <div key={f.path}>
                  <div className="folder-row" onClick={() => setSel(sel === f.path ? null : f.path)}>
                    <span className="name" style={{ fontFamily: "Consolas, monospace", fontSize: 12 }}>{f.path}</span>
                    <span className="sub" style={{ fontSize: 11, color: "var(--text-3)" }}>{f.diffs.length} 处</span>
                  </div>
                  {sel === f.path && selected && (
                    <div style={{ padding: "0 8px 8px" }}>
                      {selected.diffs.map((d, i) => (
                        <pre key={i} className="toolcall mono" style={{ whiteSpace: "pre-wrap", marginBottom: 6, background: "#fdeaea", border: "1px solid #d99a9a" }}>
                          {d.oldText === null ? `[新建文件，撤回将删除]\n${d.newText.slice(0, 400)}` : `[回退此修改]\n- ${d.oldText.slice(0, 400)}\n+ ${d.newText.slice(0, 400)}`}
                        </pre>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {files.length > 3 && !expanded && (
                <button className="link" style={{ padding: 8 }} onClick={() => setExpanded(true)}>展开全部（{files.length} 个文件）</button>
              )}
            </div>
          )}
        </div>
        <footer>
          <button className="btn" onClick={onCancel}>取消</button>
          {files.length > 0 && <button className="btn" onClick={onMessagesOnly}>仅撤回消息</button>}
          <button className="btn primary" onClick={onConfirm}>撤回并回退文件</button>
        </footer>
      </div>
    </div>
  );
}
