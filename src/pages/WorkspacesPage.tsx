import { useState } from "react";
import type { WorkspaceId } from "@deepseek-ai/dsh-host-apiproxy/api";
import { appStore, useAppState } from "../lib/dsh/store";
import { Card, shortId } from "../components/ui";
import { FolderBrowser } from "../components/FolderBrowser";

export function WorkspacesPage() {
  const { workspaces, connected } = useAppState();
  const [browse, setBrowse] = useState(false);
  const [renameId, setRenameId] = useState<WorkspaceId | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<WorkspaceId | null>(null);

  return (
    <div style={{ maxWidth: 760 }}>
      <Card
        title="工作区"
        extra={
          <button className="btn sm primary" disabled={!connected} onClick={() => setBrowse(true)}>
            + 添加工作区
          </button>
        }
      >
        {!connected && <div className="muted">dsh 未连接，无法管理工作区</div>}
        {connected && workspaces.length === 0 && <div className="empty-state">尚无工作区，点击右上角添加</div>}
        <ul className="list">
          {workspaces.map((w) => (
            <li key={w.workspaceId} className="list-item">
              <span className="title">{w.title}</span>
              <span className="sub">{w.path ?? shortId(w.workspaceId)}</span>
              <span className="actions">
                <button className="btn sm" onClick={() => { setRenameId(w.workspaceId); setRenameTitle(w.title); }}>
                  重命名
                </button>
                <button className="btn sm danger" onClick={() => setConfirmDelete(w.workspaceId)}>删除</button>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {browse && (
        <FolderBrowser
          title="选择工作区目录"
          onPick={(path) => { void appStore.addWorkspace(path); setBrowse(false); }}
          onClose={() => setBrowse(false)}
        />
      )}

      {renameId && (
        <div className="modal-overlay">
          <div className="modal">
            <header>重命名工作区</header>
            <div className="modal-body">
              <input
                className="input"
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.currentTarget.value)}
                autoFocus
              />
            </div>
            <footer>
              <button className="btn subtle" onClick={() => setRenameId(null)}>取消</button>
              <button
                className="btn primary"
                onClick={() => { void appStore.renameWorkspace(renameId, renameTitle.trim()); setRenameId(null); }}
              >
                保存
              </button>
            </footer>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="modal-overlay">
          <div className="modal">
            <header>删除工作区</header>
            <div className="modal-body">
              仅删除工作区注册信息，目录、文件与会话日志都不会被删除。确认？
            </div>
            <footer>
              <button className="btn subtle" onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="btn danger" onClick={() => { void appStore.deleteWorkspace(confirmDelete); setConfirmDelete(null); }}>
                删除
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

