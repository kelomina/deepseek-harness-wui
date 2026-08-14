import { useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import { shortId } from "../components/ui";
import type { WorkspaceId } from "@deepseek-ai/dsh-host-apiproxy/api";

export function WorkspacesPage() {
  const { workspaces, connected } = useAppState();
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
        {workspaces.map((w) => (
          <div className="ws-row" key={w.workspaceId}>
            <span className="ws-name">{w.title}</span>
            <span className="ws-path">{w.path ?? shortId(w.workspaceId)}</span>
            <span className="ws-act">
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


