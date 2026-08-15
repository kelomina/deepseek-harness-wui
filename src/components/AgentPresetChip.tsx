import { useEffect, useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

function presetInitial(p: { id: string; name?: string }): string {
  const n = (p.name ?? p.id).trim();
  return n ? n[0] : "?";
}

/**
 * Agent 模式选择 chip：弹出菜单向上展开，点击外部 / Esc 自动关闭。
 * - 无 sessionId：暂存选择，应用于「下一个新会话」（新建任务页）。
 * - 有 sessionId：直接应用到该会话；会话已开始（非空白）时 dsh 拒绝更换，列表置灰并提示。
 */
export function AgentPresetChip({ sessionId, onOpenSettings }: { sessionId?: SessionId; onOpenSettings?: () => void }) {
  const { agentPresets, pendingAgentPreset, sessions } = useAppState();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const pickable = (agentPresets ?? []).filter((p) => !p.broken);
  const userPresets = pickable.filter((p) => p.trust === "user");
  const systemPresets = pickable.filter((p) => p.trust === "system");
  const defaultPreset = pickable.find((p) => p.isDefault) ?? null;

  const session = sessionId ? sessions.find((s) => s.sessionId === sessionId) : undefined;
  const sessionPresetId = session?.agentPreset ?? undefined;
  const locked = !!sessionId && session?.blank !== true;
  const selectedId = sessionId
    ? sessionPresetId ?? defaultPreset?.id ?? null
    : pendingAgentPreset ?? defaultPreset?.id ?? null;
  const selected = pickable.find((p) => p.id === selectedId) ?? null;
  const selectedName = selected?.name ?? selected?.id ?? sessionPresetId ?? "标准模式";

  const choose = (id: string) => {
    if (sessionId) {
      if (locked) {
        appStore.set({ error: "会话已开始，Agent 模式固定不可更换；如需更换请新建会话" });
        return; // 保持弹层打开，便于查看列表
      }
      void appStore.applyAgentPresetToSession(sessionId, id);
    } else {
      appStore.setPendingAgentPreset(id);
    }
    setOpen(false);
  };

  const presetRow = (p: { id: string; name?: string; description?: string; trust: string; isDefault: boolean }) => (
    <div
      key={p.id}
      className={`preset-row${p.id === selectedId ? " selected" : ""}${locked ? " locked" : ""}`}
      onClick={() => choose(p.id)}
      title={locked ? "会话已开始，无法更换 Agent 模式" : undefined}
    >
      <span className="preset-ico">{presetInitial(p)}</span>
      <span className="preset-meta">
        <span className="preset-nm">
          {p.name ?? p.id}
          {p.trust === "user" && <span className="badge user">自定义</span>}
          {p.isDefault && <span className="badge def">默认</span>}
        </span>
        {p.description && <span className="preset-ds">{p.description}</span>}
      </span>
      {locked && <span className="badge off">锁定</span>}
    </div>
  );

  return (
    <div className="agent-chip" onClick={() => setOpen((v) => !v)}>
      <span>Agent 模式</span>
      <span className="agent-tag">{selectedName}</span>
      <span className="caret">▾</span>
      {open && (
        <>
          <div className="pop-close" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className="agent-pop" onClick={(e) => e.stopPropagation()}>
            <div className="agent-pop-h">
              {locked ? "本会话已开始，Agent 模式固定；以下仅供查看" : sessionId ? "为当前空白会话选择 Agent 模式（立即生效）" : "为即将开始的会话选择 Agent 模式（仅对新会话生效）"}
            </div>
            {userPresets.map((p) => presetRow(p))}
            {systemPresets.map((p) => presetRow(p))}
            <div className="agent-pop-foot">
              {onOpenSettings && (
                <span className="link" onClick={(e) => { e.stopPropagation(); setOpen(false); onOpenSettings(); }}>在设置中管理 Agent 模式…</span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
