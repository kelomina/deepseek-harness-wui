import { useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import { shortId } from "../components/ui";
import type { WorkspaceId } from "@deepseek-ai/dsh-host-apiproxy/api";

export function WorkspacesPage() {
  const { workspaces, connected, host } = useAppState();
  const [renameId, setRenameId] = useState<WorkspaceId | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<WorkspaceId | null>(null);
  const addWorkspace = async () => {
    try {
      const p = await appStore.pickDirectory();
      if (p) await appStore.addWorkspace(p);
    } catch (e) {
      appStore.set({ error: String(e) });
    }
  };
  // 上移=插到前一行之前；下移=插到后一行之后（anchor=再下一行，省略=移到末尾）
  const move = (idx: number, dir: -1 | 1) => {
    const w = workspaces[idx];
    if (!w) return;
    if (dir === -1) {
      const anchor = workspaces[idx - 1];
      if (!anchor) return;
      void appStore.moveWorkspace(w.workspaceId, anchor.workspaceId);
    } else {
      const anchor = workspaces[idx + 2];
      void appStore.moveWorkspace(w.workspaceId, anchor?.workspaceId);
    }
  };
  const openDir = async (path: string) => {
    try {
      await appStore.openPath(path);
    } catch (e) {
      appStore.set({ error: String(e) });
    }
  };

  return (
    <section className="view active" id="view-workspaces">
      <div className="col col-ws">
        <div className="view-cap">工作区</div>
        <div className="card-head">
          <span className="card-title">工作区</span>
          <button className="btn" disabled={!connected} onClick={() => void addWorkspace()}>＋ 添加工作区</button>
        </div>
        {!connected && <div className="muted" style={{ marginTop: 8 }}>dsh 未连接，无法管理工作区</div>}
        {connected && workspaces.length === 0 && <div className="empty-state">尚无工作区，点击右上角添加</div>}
        {workspaces.map((w, i) => (
          <div className="ws-row" key={w.workspaceId}>
            <span className="ws-order">
              <button className="ws-order-btn" title="上移" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button className="ws-order-btn" title="下移" disabled={i === workspaces.length - 1} onClick={() => move(i, 1)}>↓</button>
            </span>
            <span className="ws-name">{w.title}</span>
            <span className="ws-path">{w.path ?? shortId(w.workspaceId)}</span>
            <span className="ws-act">
              {host?.canOpenPath && w.path && (
                <button className="mgmt-btn" title="在系统文件管理器中打开" onClick={() => void openDir(w.path!)}>
                  <span className="ico">⭱</span>打开目录
                </button>
              )}
              <span className="link" onClick={() => { setRenameId(w.workspaceId); setRenameTitle(w.title); }}>重命名</span>
              <span className="link danger" onClick={() => setConfirmDelete(w.workspaceId)}>删除</span>
            </span>
          </div>
        ))}
      </div>


      {renameId && (
        <div className="modal-overlay">
          <div className="modal">
            <header>重命名工作区</header>
            <div className="modal-body">
              <input className="grow" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", width: "100%" }} value={renameTitle} onChange={(e) => setRenameTitle(e.currentTarget.value)} autoFocus />
            </div>
            <footer>
              <button className="btn" onClick={() => setRenameId(null)}>取消</button>
              <button className="btn primary" onClick={() => { void appStore.renameWorkspace(renameId, renameTitle.trim()); setRenameId(null); }}>保存</button>
            </footer>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-overlay">
          <div className="modal">
            <header>删除工作区</header>
            <div className="modal-body">仅删除工作区注册信息，目录、文件与会话日志都不会被删除。确认？</div>
            <footer>
              <button className="btn" onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="btn danger-o" onClick={() => { void appStore.deleteWorkspace(confirmDelete); setConfirmDelete(null); }}>删除</button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}


