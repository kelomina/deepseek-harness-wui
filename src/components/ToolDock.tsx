import { useEffect } from "react";
import { TD_DEFAULT, TD_MAX, TD_MIN, TD_WIDTH_KEY, useResizableWidth } from "../lib/panelResize";
import { appStore, useAppState } from "../lib/dsh/store";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { useConversationItems } from "./Conversation";
import { ToolViews } from "./ToolViews";
import { GoalBar, QueueDock, SubagentPanel } from "./SessionExtras";
import { LogPanel } from "./LogPanel";
import { TeamBoard, useTeamPendingCount } from "./TeamBoard";
import { useUnreadErrors } from "../lib/logger";

export type ToolTab = "files" | "terminal" | "web" | "git" | "session" | "logs" | "team";
export type SessionSubTab = "goal" | "queue" | "subagents" | "skills";

const TAB_LABELS: Record<ToolTab, string> = {
  files: "文件",
  terminal: "终端",
  web: "浏览器",
  git: "Git",
  session: "会话",
  logs: "日志",
  team: "团队",
};

const SUB_TAB_LABELS: { id: SessionSubTab; label: string; icon: string }[] = [
  { id: "goal", label: "目标", icon: "◎" },
  { id: "queue", label: "队列", icon: "☰" },
  { id: "subagents", label: "子代理", icon: "◔" },
  { id: "skills", label: "技能", icon: "✦" },
];

/** 会话功能坞「技能」子面板：读 store.skills，点击技能置位 pendingSkillInsert（功能坞保持打开）。 */
function SkillListPanel({ sessionId, onInsert }: { sessionId: SessionId; onInsert: (name: string) => void }) {
  const { skills, skillsUnavailable } = useAppState();
  useEffect(() => {
    if (skills === null && !skillsUnavailable) void appStore.loadSkills(sessionId);
  }, [sessionId, skills, skillsUnavailable]);
  return (
    <div className="sd-skills">
      <div className="sd-pane-title">项目技能（点击插入 /名称）</div>
      {skillsUnavailable && (
        <div className="empty-state">
          会话未在本进程内激活（attached），暂不可读取技能。向该会话发送一条消息后再试。
        </div>
      )}
      {!skillsUnavailable && skills === null && <div className="muted" style={{ padding: "8px 2px" }}>加载中…</div>}
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
            title={t.label}
            onClick={() => onSubTabChange(t.id)}
          >
            <span className="sd-seg-ico">{t.icon}</span>
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
  hideTeamTab,
}: {
  tab: ToolTab;
  onTabChange: (t: ToolTab) => void;
  onClose: () => void;
  sessionSubTab: SessionSubTab;
  onSessionSubTabChange: (t: SessionSubTab) => void;
  /** PRD-004 v1.1：Work 主界面（team view）下 Dock 内 team 第七 tab 去重隐藏，防套娃。 */
  hideTeamTab?: boolean;
}) {
  const { host, activeWorkspaceId, workspaces, selectedSessionId } = useAppState();
  const unreadErrors = useUnreadErrors();
  const teamPending = useTeamPendingCount();
  const items = useConversationItems();
  const activeWs = workspaces.find((w) => w.workspaceId === activeWorkspaceId) ?? null;
  const visibleTabs = (["files", "terminal", "web", "git", "session", "logs", "team"] as ToolTab[]).filter(
    (t) => !(hideTeamTab && t === "team"),
  );
  const effectiveTab: ToolTab = hideTeamTab && tab === "team" ? "files" : tab;
  // 汉堡弹出后的右侧抽屉：左边缘把手调宽（复用 panelResize 同套 pointer+clamp+持久化，dir=-1 右锚定）
  const { width: dockWidth, setWidth: setDockWidth, startDrag: startDockDrag, onKey: onDockKey } =
    useResizableWidth(TD_WIDTH_KEY, TD_DEFAULT, TD_MIN, TD_MAX);

  return (
    <div className="tool-dock tool-resizable" style={{ width: dockWidth }}>
      <div
        className="td-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整工具面板宽度"
        title="拖动调整宽度（双击恢复默认）"
        tabIndex={0}
        onPointerDown={(e) => {
          e.stopPropagation();
          startDockDrag(e, -1);
        }}
        onKeyDown={(e) => onDockKey(e, -1)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDockWidth(TD_DEFAULT);
        }}
      />
      <div className="td-head">
        <div className="td-tabs" style={{ whiteSpace: "nowrap", overflowX: "auto", overflowY: "hidden" }}>
          {visibleTabs.map((t) => (
            <span
              key={t}
              className={`t-tab${effectiveTab === t ? " on" : ""}`}
              onClick={() => onTabChange(t)}
            >
              {TAB_LABELS[t]}
              {t === "logs" && unreadErrors > 0 && (
                <span className="t-badge error">{unreadErrors}</span>
              )}
              {t === "team" && teamPending > 0 && (
                <span className="t-badge error">{teamPending}</span>
              )}
            </span>
          ))}
        </div>
        <button className="td-close" title="关闭" onClick={onClose}>×</button>
      </div>
      <div className="td-body">
        {effectiveTab === "team" ? (
          <TeamBoard />
        ) : effectiveTab === "logs" ? (
          <LogPanel compact />
        ) : effectiveTab === "session" ? (
          <SessionPanel
            subTab={sessionSubTab}
            onSubTabChange={onSessionSubTabChange}
            sessionId={selectedSessionId}
            onSkillInsert={(name) => appStore.setSkillInsert(name)}
          />
        ) : (
          <ToolViews
            key={effectiveTab}
            items={items}
            workspaceRoot={activeWs?.path ?? host?.cwd ?? null}
            canOpenPath={host?.canOpenPath ?? null}
            initialTab={effectiveTab}
            compact
          />
        )}
      </div>
    </div>
  );
}