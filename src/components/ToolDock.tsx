import { useEffect } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { useConversationItems } from "./Conversation";
import { ToolViews } from "./ToolViews";
import { GoalBar, QueueDock, SubagentPanel } from "./SessionExtras";

export type ToolTab = "files" | "terminal" | "web" | "git" | "session";
export type SessionSubTab = "goal" | "queue" | "subagents" | "skills";

const TAB_LABELS: Record<ToolTab, string> = {
  files: "文件",
  terminal: "终端",
  web: "浏览器",
  git: "Git",
  session: "会话",
};

const SUB_TAB_LABELS: { id: SessionSubTab; label: string }[] = [
  { id: "goal", label: "目标" },
  { id: "queue", label: "队列" },
  { id: "subagents", label: "子代理" },
  { id: "skills", label: "技能" },
];

/** 会话功能坞「技能」子面板：读 store.skills，点击技能置位 pendingSkillInsert（功能坞保持打开）。 */
function SkillListPanel({ sessionId, onInsert }: { sessionId: SessionId; onInsert: (name: string) => void }) {
  const { skills } = useAppState();
  useEffect(() => {
    if (skills === null) void appStore.loadSkills(sessionId);
  }, [sessionId, skills]);
  return (
    <div className="sd-skills">
      <div className="sd-pane-title">项目技能（点击插入 /名称）</div>
      {skills === null && <div className="muted" style={{ padding: "8px 2px" }}>加载中…</div>}
      {skills && skills.length === 0 && <div className="empty-state">当前项目无技能</div>}
      {skills && skills.map((s) => (
        <button
          key={s.name}
          className="sd-skill"
          title={s.whenToUse ? `${s.description}｜${s.whenToUse}` : s.description}
          onClick={() => onInsert(s.name)}
        >
          <span className="sd-skill-name">/{s.name}</span>
          <span className="sd-skill-desc">{s.description}</span>
        </button>
      ))}
    </div>
  );
}

function SessionPanel({
  subTab,
  onSubTabChange,
  sessionId,
  onSkillInsert,
}: {
  subTab: SessionSubTab;
  onSubTabChange: (t: SessionSubTab) => void;
  sessionId: SessionId | null;
  onSkillInsert: (name: string) => void;
}) {
  return (
    <div className="sd-panel">
      <div className="sd-seg">
        {SUB_TAB_LABELS.map((t) => (
          <button
            key={t.id}
            className={`sd-seg-item${subTab === t.id ? " on" : ""}`}
            onClick={() => onSubTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="sd-body">
        {!sessionId ? (
          <div className="empty-state">未选择会话（从左侧任务列表选择）</div>
        ) : subTab === "goal" ? (
          <GoalBar sessionId={sessionId} />
        ) : subTab === "queue" ? (
          <QueueDock sessionId={sessionId} />
        ) : subTab === "subagents" ? (
          <SubagentPanel sessionId={sessionId} onClose={() => undefined} inline />
        ) : (
          <SkillListPanel sessionId={sessionId} onInsert={onSkillInsert} />
        )}
      </div>
    </div>
  );
}

export function ToolDock({
  tab,
  onTabChange,
  onClose,
  sessionSubTab,
  onSessionSubTabChange,
}: {
  tab: ToolTab;
  onTabChange: (t: ToolTab) => void;
  onClose: () => void;
  sessionSubTab: SessionSubTab;
  onSessionSubTabChange: (t: SessionSubTab) => void;
}) {
  const { host, activeWorkspaceId, workspaces, selectedSessionId } = useAppState();
  const items = useConversationItems();
  const activeWs = workspaces.find((w) => w.workspaceId === activeWorkspaceId) ?? null;

  return (
    <div className="tool-dock">
      <div className="td-head">
        <div className="td-tabs">
          {(["files", "terminal", "web", "git", "session"] as ToolTab[]).map((t) => (
            <span
              key={t}
              className={`t-tab${tab === t ? " on" : ""}`}
              onClick={() => onTabChange(t)}
            >
              {TAB_LABELS[t]}
            </span>
          ))}
        </div>
        <button className="td-close" title="关闭" onClick={onClose}>×</button>
      </div>
      <div className="td-body">
        {tab === "session" ? (
          <SessionPanel
            subTab={sessionSubTab}
            onSubTabChange={onSessionSubTabChange}
            sessionId={selectedSessionId}
            onSkillInsert={(name) => appStore.setSkillInsert(name)}
          />
        ) : (
          <ToolViews
            key={tab}
            items={items}
            workspaceRoot={activeWs?.path ?? host?.cwd ?? null}
            initialTab={tab}
            compact
          />
        )}
      </div>
    </div>
  );
}