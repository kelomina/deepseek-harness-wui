import { useMemo, useState } from "react";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { useAppState } from "../lib/dsh/store";
import {
  TRACE_MAX_ROWS,
  forkLabel,
  listPendingAdmits,
  listTaskCards,
  loadEmployees,
  shortTeamId,
  unbindSession,
} from "../lib/team";
import { shortId } from "./ui";
import { ApprovalCenter } from "./ApprovalCenter";

/** branded SessionId 与本地 string 会话 id 互转（归属表存 string，不脑补后端字段）。 */
const sid = (s: string): SessionId => s as unknown as SessionId;

/**
 * TeamBoard — ToolDock team tab 黑板（四区只读聚合，不新增 dsh 投影键）。
 * ①员工墙 ②任务卡墙 ③申请中心入口 ④运行 Trace（近 100 条）。
 * 复用 token：empty-state / dot / badge / queue-item / log-row / card / btn sm。
 */
export function TeamBoard() {
  const { sessions, interactives, projections, sessionQueues, subagentCatalogs, live, host, history, archivedSessionIds } =
    useAppState();
  const [tick, setTick] = useState(0);
  const [approvalOpen, setApprovalOpen] = useState(false);

  const employees = useMemo(() => loadEmployees(), [tick]);
  const tasks = useMemo(() => listTaskCards(), [tick]);
  const admits = useMemo(() => listPendingAdmits(), [tick, approvalOpen]);

  const pendingApprovals = interactives.filter((i) => i.kind === "approval");
  const questionCount = interactives.filter((i) => i.kind === "question").length;
  const pendingTotal = pendingApprovals.length + admits.length;
  const runningTotal = sessions.filter((s) => s.running).length;

  const trace = useMemo(() => {
    const rows: Array<{ type: string; seq: number; sid: string }> = [];
    for (const [sid, frames] of live) {
      for (const f of frames as Array<{ type: string; event?: { type?: string; seq?: number } }>) {
        if (f.type === "session/event" && f.event) {
          rows.push({ type: f.event.type ?? f.type, seq: f.event.seq ?? -1, sid });
        }
      }
    }
    return rows.slice(-TRACE_MAX_ROWS).reverse();
  }, [live]);

  if (employees.length === 0) {
    return (
      <div className="sd-panel">
        <div className="sd-pane-title">团队黑板（只读聚合）</div>
        <div className="empty-state">未选团队（先创建员工并绑定会话）</div>
        <div className="queue-dock">
          <div className="queue-head">申请中心入口</div>
          <div className="queue-item">
            <span className="queue-text">待审批 {pendingTotal}（question 仅计数：{questionCount}）</span>
            <button className="btn sm" onClick={() => setApprovalOpen(true)}>进入申请中心</button>
          </div>
        </div>
        {approvalOpen && <ApprovalCenter onClose={() => { setApprovalOpen(false); setTick((t) => t + 1); }} />}
      </div>
    );
  }

  return (
    <div className="sd-panel">
      <div className="sd-pane-title">
        团队黑板（只读聚合）· 运行 {runningTotal} / 待审 {pendingTotal}
        <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setTick((t) => t + 1)}>刷新</button>
      </div>
      <div className="sd-body">
        {/* ①员工墙 */}
        <div className="card" style={{ padding: 10 }}>
          <div className="queue-head">员工墙</div>
          {employees.map((e) => {
            const goalPhases = e.sessionIds.map(
              (s) => (projections.get(sid(s))?.["goal"]?.value as { goal?: { phase: string } } | undefined)?.goal?.phase ?? null,
            );
            const phase = goalPhases.find((p) => p) ?? null;
            const queueN = e.sessionIds.reduce((n, s) => n + (sessionQueues.get(sid(s))?.length ?? 0), 0);
            const runningSubs = e.sessionIds.reduce(
              (n, s) => n + (subagentCatalogs.get(sid(s))?.entries.filter((x) => x.kind === "child" && x.activity === "running").length ?? 0),
              0,
            );
            const awaiting = pendingApprovals.filter((a) => e.sessionIds.includes(String(a.sessionId))).length;
            const dot = awaiting > 0 ? "" : runningSubs > 0 || e.sessionIds.some((s) => sessions.find((x) => x.sessionId === sid(s))?.running) ? " green" : "";
            return (
              <div className="queue-item" key={e.id} title={e.bio}>
                <span className={`dot${dot}`} />
                <span className="queue-text">
                  {e.avatar} {e.name}（{e.role} · 天花板 {e.ceiling}）
                  {phase ? ` · 目标 ${phase}` : ""} · 队列 {queueN} · 子代理 {runningSubs}
                  {awaiting > 0 && <span className="badge orange" style={{ marginLeft: 6 }}>待审 {awaiting}</span>}
                </span>
              </div>
            );
          })}
          {/* 会话级徽标：fork 派生 / cold 仅可读 / 已归档 / canOpenPath */}
          {employees.flatMap((e) =>
            e.sessionIds.map((raw) => {
              const labels: string[] = [];
              const fork = forkLabel(employees, raw);
              if (fork) labels.push(fork);
              if (archivedSessionIds.includes(sid(raw))) labels.push("已归档（已自动解绑，仅可读）");
              else if (!history.has(sid(raw))) labels.push("cold，仅可读（先发送一条消息激活）");
              if (host && !host.canOpenPath) labels.push("canOpenPath=false（显式禁绑）");
              if (labels.length === 0) return null;
              return (
                <div className="queue-item" key={raw}>
                  <span className="badge gray">{shortId(sid(raw))}</span>
                  <span className="queue-detail">{labels.join("；")}</span>
                  {archivedSessionIds.includes(sid(raw)) && (
                    <button
                      className="btn sm"
                      onClick={() => {
                        unbindSession(raw);
                        setTick((t) => t + 1);
                      }}
                    >
                      解绑留痕
                    </button>
                  )}
                </div>
              );
            }),
          )}
        </div>

        {/* ②任务卡墙 */}
        <div className="card" style={{ padding: 10 }}>
          <div className="queue-head">任务卡墙（{tasks.length}，上限并行 4 路）</div>
          {tasks.length === 0 && <div className="empty-state">暂无任务卡（团长拆解后下发）</div>}
          {tasks.map((t) => (
            <div className="queue-item" key={t.clientTaskId} title={`输入：${t.inputScope}｜输出：${t.outputTo}｜禁止：${t.forbidden}｜审批预期：${t.approvalNote}`}>
              <span className={`badge ${t.status === "passed" ? "green" : t.status === "rejected" ? "cond" : t.status === "running" ? "green" : "gray"}`}>
                {t.status === "todo" ? "待派" : t.status === "running" ? "进行中" : t.status === "review" ? "待验收" : t.status === "passed" ? "通过" : "打回"}
              </span>
              <span className="queue-text">{t.title}</span>
              {t.evidence && <span className="queue-detail">{shortTeamId(t.evidence.sessionId)}@{t.evidence.seq}</span>}
            </div>
          ))}
        </div>

        {/* ③申请中心入口（红点与 ent-bar / team tab t-badge 同源同数） */}
        <div className="card" style={{ padding: 10 }}>
          <div className="queue-head">申请中心入口</div>
          <div className="queue-item">
            <span className="queue-text">
              待审批 {pendingTotal}（dsh {pendingApprovals.length} / 插件 {admits.length}；question 仅计数：{questionCount}）
            </span>
            <button className="btn sm primary" onClick={() => setApprovalOpen(true)}>进入申请中心</button>
          </div>
        </div>

        {/* ④运行 Trace（近 100 条摘要，全文查历史） */}
        <div className="card" style={{ padding: 10 }}>
          <div className="queue-head">运行 Trace（近 {TRACE_MAX_ROWS} 条）</div>
          {trace.length === 0 && <div className="empty-state">暂无运行帧（会话产生事件后展示）</div>}
          {trace.map((r, i) => (
            <div className="log-row log-info" key={`${r.sid}-${r.seq}-${i}`}>
              <div className="log-row-main">
                <span className="log-msg">{r.type}@{r.seq} · {shortTeamId(r.sid)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
      {approvalOpen && <ApprovalCenter onClose={() => { setApprovalOpen(false); setTick((t) => t + 1); }} />}
    </div>
  );
}

export function useTeamPendingCount(): number {
  const { interactives } = useAppState();
  return useMemo(
    () => interactives.filter((i) => i.kind === "approval").length + listPendingAdmits().length,
    [interactives],
  );
}
