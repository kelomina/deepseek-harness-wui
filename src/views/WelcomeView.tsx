import { useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import { parseDispatchCommand } from "../lib/team";
import { ModelMenu } from "../components/ModelMenu";
import { WorkspaceMenu } from "../components/WorkspaceMenu";
import { AgentPresetChip } from "../components/AgentPresetChip";
import { PermissionMenu } from "../components/PermissionMenu";
import { HamburgerMenu, type ToolTab } from "../components/HamburgerMenu";

export function WelcomeView({
  mode,
  onEnterSession,
  onOpenSettings,
  onOpenToolDock,
}: {
  mode: "work" | "code";
  onEnterSession: () => void;
  onOpenSettings: () => void;
  onOpenToolDock: (tab: ToolTab) => void;
}) {
  const { connected } = useAppState();
  const [draft, setDraft] = useState("");

  const send = async () => {
    const text = draft.trim();
    if (!text || !connected) return;
    // PRD-dispatch S0：非 Work 会话键入 /分派 显式提示，不跨模式执行（Welcome 无会话上下文，不触发 S1）。
    const cmd = parseDispatchCommand(text);
    if (cmd) {
      if ("empty" in cmd) {
        appStore.set({ notice: "用法：/分派 <需求>（请先进入 Work 会话后再分派）" });
        return;
      }
      appStore.set({ notice: "请到 Work 模式使用（欢迎页不直接分派，请先进入 Work 会话）" });
      return;
    }
    const id = await appStore.createSession();
    if (id) {
      await appStore.sendPrompt(id, text);
      setDraft("");
      onEnterSession();
    }
  };

  return (
    <section className="view active" id="view-welcome">
      <div className="hamburger-top-right">
        <HamburgerMenu onOpenTool={onOpenToolDock} />
      </div>
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
            <PermissionMenu />
            <button className="env-btn" title="执行环境（开发中）">本地 <span className="caret">▾</span></button>
            <WorkspaceMenu />
            <AgentPresetChip onOpenSettings={onOpenSettings} />
            <span className="chip-note">模式在会话创建时固定，运行中的会话保持其初始模式</span>
          </div>
        </div>
      </div>
    </section>
  );
}
