import { useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import { ModelMenu } from "../components/ModelMenu";
import { WorkspaceMenu } from "../components/WorkspaceMenu";

export function WelcomeView({
  mode,
  onEnterSession,
  onOpenSettings,
}: {
  mode: "work" | "code";
  onEnterSession: () => void;
  onOpenSettings: () => void;
}) {
  const { connected } = useAppState();
  const [draft, setDraft] = useState("");


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
        <h1 className="hero">
          <span className="logo">{mode === "work" ? "|>_" : "</>"}</span>
          {mode === "work" ? "Work with DeepSeek-Harness" : "Code with DeepSeek-Harness"}
        </h1>
        <div className="composer-wrap">
          <div className="composer">
            <textarea
              className="composer-input"
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              placeholder="帮你编写代码、调试 Bug、优化性能等开发工作，交付生产级代码产物。"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="toolbar">
              <div className="tools"><button className="plus-btn" title="附件（开发中）">+</button></div>
              <div className="tools">
                <ModelMenu onOpenSettings={onOpenSettings} />
                <button className="send-btn" title="发送" disabled={!connected || !draft.trim()} onClick={() => void send()}>↑</button>
              </div>
            </div>
          </div>
          <div className="env-bar">
            <button className="env-btn" title="执行环境（开发中）">本地 <span className="caret">▾</span></button>
            <WorkspaceMenu />

          </div>
        </div>
      </div>
    </section>
  );
}


