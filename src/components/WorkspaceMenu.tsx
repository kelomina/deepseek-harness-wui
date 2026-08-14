import { useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";

export function WorkspaceMenu() {
  const [open, setOpen] = useState(false);
  const { workspaces, activeWorkspaceId } = useAppState();
  const active = workspaces.find((w) => w.workspaceId === activeWorkspaceId) ?? null;

  const addNew = async () => {
    try {
      const p = await appStore.pickDirectory();
      if (p) await appStore.addWorkspace(p);
    } catch (e) {
      appStore.set({ error: String(e) });
    }
    setOpen(false);
  };

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <span className="folder" onClick={() => setOpen((v) => !v)}>
        📁 {active?.path ?? "选择文件夹（可选）"} <span className="caret">▾</span>
      </span>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 90 }} onClick={() => setOpen(false)} />
          <div className="model-menu" style={{ left: 0, right: "auto", top: "calc(100% + 6px)" }}>
            <div className="mm-group">工作区</div>
            {workspaces.length === 0 && <div className="muted" style={{ padding: 8 }}>暂无工作区</div>}
            {workspaces.map((w) => (
              <button
                key={w.workspaceId}
                className={`mm-item${w.workspaceId === activeWorkspaceId ? " active" : ""}`}
                onClick={() => {
                  appStore.setActiveWorkspace(w.workspaceId);
                  setOpen(false);
                }}
              >
                {w.title}
                <span className="mm-id">{w.path}</span>
              </button>
            ))}
            <div className="mm-foot">
              <button className="link" onClick={() => void addNew()}>＋ 添加文件夹…</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
