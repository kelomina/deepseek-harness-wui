import { useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import { FolderBrowser } from "../components/FolderBrowser";

export function WelcomeView({ onEnterSession, onOpenSettings }: { onEnterSession: () => void; onOpenSettings: () => void }) {
  const { connected, host, activeWorkspaceId, workspaces } = useAppState();
  const [draft, setDraft] = useState("");
  const [browse, setBrowse] = useState(false);
  const activeWs = workspaces.find((w) => w.workspaceId === activeWorkspaceId) ?? null;

  const send = async () => {
    const text = draft.trim();
    if (!text || !connected) return;
    const id = await appStore.createSession();
    if (id) {
      await appStore.sendPrompt(id, text);
      setDraft("");
      onEnterSession();
    }
  };

  return (
    <section className="view active" id="view-welcome">
      <div className="col col-welcome">
        <h1 className="hero"><span className="logo">&lt;/&gt;</span>Code with DeepSeek</h1>
        <div className="composer-wrap">
          <div className="composer">
            <div className="ph">帮你编写代码、调试 Bug、优化性能等开发工作，交付生产级代码产物。</div>
            <div className="toolbar">
              <div className="tools"><button className="plus-btn" title="附件（开发中）">+</button></div>
              <div className="tools">
                <button className="model-btn" title="配置模型" onClick={onOpenSettings}>
                  <span className="name">{host?.model ?? "DeepSeek-V4-Flash-0731(Default)"}</span>
                  <span className="caret">▾</span>
                </button>
                <button className="send-btn" title="发送" disabled={!connected || !draft.trim()} onClick={() => void send()}>↑</button>
              </div>
            </div>
          </div>
          <div className="env-bar">
            <button className="env-btn" title="执行环境（开发中）">本地 <span className="caret">▾</span></button>
            <span className="folder" onClick={() => setBrowse(true)}>
              📁 {activeWs?.path ?? "选择文件夹（可选，自动拉伸占满剩余宽度）"}
            </span>
          </div>
        </div>
      </div>
      {browse && (
        <FolderBrowser
          title="选择工作区目录"
          onPick={(path) => { void appStore.addWorkspace(path); setBrowse(false); }}
          onClose={() => setBrowse(false)}
        />
      )}
    </section>
  );
}
