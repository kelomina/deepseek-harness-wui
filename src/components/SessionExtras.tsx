import { useEffect, useRef, useState } from "react";
import type { GoalRef, SubagentListEntry } from "@deepseek-ai/dsh-host-apiproxy/api";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { appStore, useAppState } from "../lib/dsh/store";
import { normalizeConversation } from "../lib/dsh/render";
import { shortId } from "./ui";

/** 提取队列项/消息中的纯文本（ContentBlock[].text 拼接）。 */
function blocksText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (typeof c === "object" && c !== null && (c as { type?: string; text?: string }).type === "text" ? ((c as { text?: string }).text ?? "") : ""))
    .join(" ")
    .trim();
}

/* ---------------- 目标（goal 域；读侧 = goal 投影） ---------------- */

const PHASE_TEXT: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "受阻",
  complete: "已完成",
};

export function GoalBar({ sessionId }: { sessionId: SessionId }) {
  const { projections, connected } = useAppState();
  // 触发依赖 projections（applyProjection 每次产生新 Map）
  const view = projections.get(sessionId)?.["goal"]?.value as
    | { goal: { id: string; revision: number; objective: string; phase: string; maxGoalRounds: number }; roundsStarted: number }
    | null
    | undefined;
  const goal = view?.goal ?? null;
  const ref = (goal ? { id: goal.id, revision: goal.revision } : null) as GoalRef | null;
  const [creating, setCreating] = useState(false);
  const [objective, setObjective] = useState("");
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");

  if (!connected) return null;

  if (!goal) {
    return (
      <div className="goal-bar goal-bar-empty">
        {creating ? (
          <>
            <input
              className="goal-input"
              autoFocus
              placeholder="目标描述，例如：修复登录页在移动端的布局问题"
              value={objective}
              onChange={(e) => setObjective(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && objective.trim()) {
                  void appStore.goalCreate(sessionId, objective.trim());
                  setObjective("");
                  setCreating(false);
                }
                if (e.key === "Escape") setCreating(false);
              }}
            />
            <button
              className="btn sm primary"
              disabled={!objective.trim()}
              onClick={() => {
                void appStore.goalCreate(sessionId, objective.trim());
                setObjective("");
                setCreating(false);
              }}
            >
              创建
            </button>
            <button className="btn sm" onClick={() => setCreating(false)}>取消</button>
          </>
        ) : (
          <button className="goal-add link" onClick={() => setCreating(true)}>＋ 设定目标（自动多轮推进）</button>
        )}
      </div>
    );
  }

  return (
    <div className={`goal-bar phase-${goal.phase}`}>
      <span className={`badge ${goal.phase === "active" ? "green" : goal.phase === "complete" ? "gray" : "orange"}`}>
        {PHASE_TEXT[goal.phase] ?? goal.phase}
      </span>
      {editing ? (
        <>
          <input
            className="goal-input"
            autoFocus
            value={editDraft}
            onChange={(e) => setEditDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && editDraft.trim() && ref) {
                void appStore.goalEdit(sessionId, ref, editDraft.trim());
                setEditing(false);
              }
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <button
            className="btn sm primary"
            disabled={!editDraft.trim() || !ref}
            onClick={() => {
              if (ref && editDraft.trim()) void appStore.goalEdit(sessionId, ref, editDraft.trim());
              setEditing(false);
            }}
          >
            保存
          </button>
          <button className="btn sm" onClick={() => setEditing(false)}>取消</button>
        </>
      ) : (
        <>
          <span className="goal-objective" title={goal.objective}>{goal.objective}</span>
          <span className="goal-rounds">第 {view?.roundsStarted ?? 0}/{goal.maxGoalRounds} 轮</span>
          <span className="goal-act">
            <span className="link" onClick={() => { setEditDraft(goal.objective); setEditing(true); }}>编辑</span>
            {ref && goal.phase === "active" && <span className="link" onClick={() => void appStore.goalPause(sessionId, ref)}>暂停</span>}
            {ref && goal.phase === "paused" && <span className="link" onClick={() => void appStore.goalResume(sessionId, ref)}>恢复</span>}
            {ref && goal.phase !== "complete" && <span className="link" onClick={() => void appStore.goalComplete(sessionId, ref)}>完成</span>}
            {ref && <span className="link danger" onClick={() => void appStore.goalClear(sessionId, ref)}>清除</span>}
          </span>
        </>
      )}
    </div>
  );
}

/* ---------------- 队列坞 + 后台任务（session/queue + session/jobs 帧） ---------------- */

export function QueueDock({ sessionId }: { sessionId: SessionId }) {
  const { sessionQueues, sessionJobs } = useAppState();
  const queue = sessionQueues.get(sessionId) ?? [];
  const jobs = sessionJobs.get(sessionId) ?? [];
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  if (queue.length === 0 && jobs.length === 0) return null;
  return (
    <div className="queue-dock">
      {queue.length > 0 && (
        <div className="queue-section">
          <div className="queue-head">待处理队列（{queue.length}）</div>
          {queue.map((item) => (
            <div className="queue-item" key={item.id}>
              <span className={`badge ${item.placement === "steering" ? "orange" : "gray"}`}>
                {item.placement === "steering" ? "插队" : "排队"}
              </span>
              {editId === item.id ? (
                <>
                  <input
                    className="goal-input"
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && editDraft.trim()) {
                        void appStore.queueAction(sessionId, item.id, { kind: "edit", text: editDraft.trim() });
                        setEditId(null);
                      }
                      if (e.key === "Escape") setEditId(null);
                    }}
                  />
                  <button
                    className="btn sm primary"
                    disabled={!editDraft.trim()}
                    onClick={() => {
                      if (editDraft.trim()) void appStore.queueAction(sessionId, item.id, { kind: "edit", text: editDraft.trim() });
                      setEditId(null);
                    }}
                  >
                    保存
                  </button>
                  <button className="btn sm" onClick={() => setEditId(null)}>取消</button>
                </>
              ) : (
                <>
                  <span className="queue-text" title={blocksText(item.message.content)}>{blocksText(item.message.content) || "(非文本消息)"}</span>
                  <span className="goal-act">
                    <span className="link" onClick={() => { setEditId(item.id); setEditDraft(blocksText(item.message.content)); }}>编辑</span>
                    {item.placement === "queued" && (
                      <span className="link" onClick={() => void appStore.queueAction(sessionId, item.id, { kind: "steer" })}>插队</span>
                    )}
                    <span className="link danger" onClick={() => void appStore.queueAction(sessionId, item.id, { kind: "remove" })}>移除</span>
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {jobs.length > 0 && (
        <div className="queue-section">
          <div className="queue-head">后台任务（{jobs.length}）</div>
          {jobs.map((j) => (
            <div className="queue-item" key={j.id} title={j.detail ?? ""}>
              <span className={`badge ${j.status === "running" ? "green" : j.status === "stopping" ? "orange" : "gray"}`}>
                {j.status === "running" ? "运行" : j.status === "stopping" ? "停止中" : j.status === "completed" ? "完成" : j.status === "killed" ? "终止" : "失败"}
              </span>
              <span className="queue-kind">{j.kind}</span>
              <span className="queue-text" title={j.label}>{j.label}</span>
              {j.detail && <span className="queue-detail">{j.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- 子代理面板（subagent 域） ---------------- */

export function SubagentPanel({ sessionId, onClose, inline }: { sessionId: SessionId; onClose: () => void; inline?: boolean }) {
  const { subagentCatalogs, subagentHistories } = useAppState();
  const catalog = subagentCatalogs.get(sessionId);
  const [openChild, setOpenChild] = useState<SessionId | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    void appStore.loadSubagents(sessionId);
  }, [sessionId]);

  const children = (catalog?.entries ?? []).filter((e): e is SubagentListEntry & { kind: "child" } => e.kind === "child");
  const diagnostics = (catalog?.entries ?? []).filter((e) => e.kind === "diagnostic");

  const childRow = (e: SubagentListEntry & { kind: "child" }) => {
    const mode = e.mode as "one-shot" | "continuable";
    const label = e.mode === "continuable" ? e.label : (e.label ?? "一次性子代理");
    const hist = openChild === e.id ? subagentHistories.get(e.id) : undefined;
    return (
      <div className="sa-row" key={e.id}>
        <div className="sa-line">
          <span className={`dot${e.activity === "running" ? " green" : ""}`} />
          <span className="sa-label" title={label}>{label}</span>
          <span className="badge gray">{e.mode === "continuable" ? "可继续" : "一次性"}</span>
          {e.hasChildren && <span className="badge gray">有下级</span>}
          <span className="goal-act">
            <span
              className="link"
              onClick={() => {
                if (openChild === e.id) {
                  setOpenChild(null);
                } else {
                  setOpenChild(e.id);
                  void appStore.loadSubagentHistory(sessionId, e.id, mode);
                }
              }}
            >
              {openChild === e.id ? "收起记录" : "查看记录"}
            </span>
            {e.mode === "continuable" && e.activity === "running" && (
              <span className="link danger" onClick={() => void appStore.interruptSubagent(sessionId, e.id)}>中断</span>
            )}
          </span>
        </div>
        {e.mode === "continuable" && (
          <div className="sa-prompt">
            <input
              className="goal-input"
              placeholder="向该子代理发送消息…"
              value={draft}
              onChange={(ev) => setDraft(ev.currentTarget.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && draft.trim()) {
                  void appStore.promptSubagent(sessionId, e.id, draft.trim());
                  setDraft("");
                }
              }}
            />
            <button
              className="btn sm primary"
              disabled={!draft.trim()}
              onClick={() => {
                void appStore.promptSubagent(sessionId, e.id, draft.trim());
                setDraft("");
              }}
            >
              发送
            </button>
          </div>
        )}
        {hist && (
          <div className="sa-hist">
            {hist.length === 0 && <div className="muted">暂无记录</div>}
            {normalizeConversation(
              hist.map((h) => ({
                seq: (h.event as { seq: number }).seq,
                event: h.event as unknown as { type: string; seq: number; time: number; data: Record<string, unknown> },
                view: h.view,
              })).sort((a, b) => a.seq - b.seq),
            ).map((it) => (
              <div key={it.seq} className={`sa-hist-row ${it.kind}`}>
                {it.kind === "user" && <span className="sa-hist-user">{it.userText || "(空)"}</span>}
                {it.kind === "assistant" && <span className="sa-hist-asst">{it.text ?? ""}</span>}
                {it.kind === "tool" && <span className="sa-hist-tool">{it.event.type} @ {it.seq}</span>}
                {it.kind === "error" && <span className="sa-hist-tool">{it.errorText ?? it.event.type}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={inline ? "sd-subagents" : "modal-mask"} onClick={inline ? undefined : onClose}>
      <div className={inline ? "sd-subagents-inner" : "modal sa-modal"} onClick={(e) => e.stopPropagation()}>
        <h4>
          子代理 · {shortId(sessionId)}
          {!catalog?.parentAvailable && <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>（父代理不在线，仅可读）</span>}
        </h4>
        {children.length === 0 && diagnostics.length === 0 && <div className="empty-state">该会话没有子代理</div>}
        {children.map(childRow)}
        {diagnostics.map((d) => (
          <div className="sa-row" key={"diagnostic" in d ? d.id : ""}>
            <span className="muted">不可读子代理 {shortId(("id" in d ? d.id : "") as string)}（原因：{"reason" in d ? d.reason : "unknown"}）</span>
          </div>
        ))}
        {inline ? null : (
          <div className="modal-row">
            <button className="btn" onClick={onClose}>关闭</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- 技能菜单（skill.list；点击插入 /name） ---------------- */

export function SkillsMenu({ sessionId, onInsert }: { sessionId: SessionId; onInsert: (name: string) => void }) {
  const { skills } = useAppState();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) void appStore.loadSkills(sessionId);
  }, [open, sessionId]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="skills-wrap" ref={boxRef}>
      <button className="env-btn" onClick={() => setOpen((v) => !v)}>技能 <span className="caret">▾</span></button>
      {open && (
        <div className="model-menu skills-menu">
          <div className="mm-title">项目技能（输入 /名称 调用）</div>
          {skills === null && <div className="muted" style={{ padding: "4px 12px" }}>加载中…</div>}
          {skills && skills.length === 0 && <div className="muted" style={{ padding: "4px 12px" }}>当前项目无技能</div>}
          {skills && skills.map((s) => (
            <button
              key={s.name}
              className="mm-item"
              title={s.whenToUse ? `${s.description}｜${s.whenToUse}` : s.description}
              onClick={() => {
                onInsert(s.name);
                setOpen(false);
              }}
            >
              <span className="mm-name">/{s.name}</span>
              <span className="mm-desc">{s.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
