import { useMemo, useState } from "react";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { useAppState, appStore } from "../lib/dsh/store";
import {
  EMP_MAX_COUNT,
  EMP_NAME_MAX,
  ROLE_MAX_COUNT,
  ROLE_NAME_MAX,
  TRACE_MAX_ROWS,
  createEmployee,
  createRoleTemplate,
  deleteEmployee,
  deleteRoleTemplate,
  forkLabel,
  getRoleTemplate,
  getTrustedDispatch,
  isAutoReviewEnabled,
  listAllRoleTemplates,
  listPendingAdmits,
  listTaskCards,
  listTrustedLog,
  loadCustomRoleTemplates,
  loadEmployees,
  renameEmployee,
  setTrustedDispatch,
  shortTeamId,
  unbindSession,
  updateRoleTemplate,
  type Employee,
  type RoleTemplate,
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
  const { sessions, interactives, projections, sessionQueues, subagentCatalogs, live, host, history, archivedSessionIds, selectedSessionId, autoReviewModel } =
    useAppState();
  const [tick, setTick] = useState(0);
  const [approvalOpen, setApprovalOpen] = useState(false);
  // 员工 CRUD（SPEC 2026-09-07T00:10Z：纯本地 modal，复用 modal-mask z200 / btn sm / badge）。
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createRole, setCreateRole] = useState<string>("frontend");
  const [createErr, setCreateErr] = useState("");
  const [renameTarget, setRenameTarget] = useState<Employee | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameErr, setRenameErr] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null);
  const [deleteErr, setDeleteErr] = useState("");
  // 任务#1 自定义岗位模板 CRUD（纯 localStorage，零新增 invoke；上限 20；重名大小写不敏感拒绝；被引用禁删）。
  const [tplCreateOpen, setTplCreateOpen] = useState(false);
  const [tplName, setTplName] = useState("");
  const [tplPersona, setTplPersona] = useState("");
  const [tplM1, setTplM1] = useState("");
  const [tplM2, setTplM2] = useState("");
  const [tplM3, setTplM3] = useState("");
  const [tplErr, setTplErr] = useState("");
  const [tplEditTarget, setTplEditTarget] = useState<RoleTemplate | null>(null);
  const [tplEditName, setTplEditName] = useState("");
  const [tplEditPersona, setTplEditPersona] = useState("");
  const [tplEditM1, setTplEditM1] = useState("");
  const [tplEditM2, setTplEditM2] = useState("");
  const [tplEditM3, setTplEditM3] = useState("");
  const [tplEditErr, setTplEditErr] = useState("");
  const [tplDeleteTarget, setTplDeleteTarget] = useState<RoleTemplate | null>(null);
  const [tplDeleteErr, setTplDeleteErr] = useState("");

  const openCreate = () => { setCreateName(""); setCreateRole("frontend"); setCreateErr(""); setCreateOpen(true); };
  const submitCreate = () => {
    const r = createEmployee({ name: createName, role: createRole });
    if (!r.ok) { setCreateErr(r.error); return; }
    setCreateOpen(false);
    setTick((t) => t + 1);
  };
  const openTplCreate = () => { setTplName(""); setTplPersona(""); setTplM1(""); setTplM2(""); setTplM3(""); setTplErr(""); setTplCreateOpen(true); };
  const submitTplCreate = () => {
    const r = createRoleTemplate({
      name: tplName,
      persona: tplPersona.trim() || undefined,
      methods: [tplM1.trim() || "遵守团队禁止事项", tplM2.trim() || "高风险动作转人工", tplM3.trim() || "留痕可审计"],
    });
    if (!r.ok) { setTplErr(r.error); return; }
    setTplCreateOpen(false);
    setTick((t) => t + 1);
  };
  const openTplEdit = (t: RoleTemplate) => {
    setTplEditTarget(t);
    setTplEditName(t.name);
    setTplEditPersona(t.persona);
    setTplEditM1(t.methods[0] ?? "");
    setTplEditM2(t.methods[1] ?? "");
    setTplEditM3(t.methods[2] ?? "");
    setTplEditErr("");
  };
  const submitTplEdit = () => {
    if (!tplEditTarget) return;
    const r = updateRoleTemplate(tplEditTarget.id, {
      name: tplEditName,
      persona: tplEditPersona,
      methods: [tplEditM1, tplEditM2, tplEditM3],
    });
    if (!r.ok) { setTplEditErr(r.error); return; }
    setTplEditTarget(null);
    setTick((t) => t + 1);
  };
  const openTplDelete = (t: RoleTemplate) => { setTplDeleteTarget(t); setTplDeleteErr(""); };
  const submitTplDelete = () => {
    if (!tplDeleteTarget) return;
    const r = deleteRoleTemplate(tplDeleteTarget.id);
    if (!r.ok) { setTplDeleteErr(r.error); return; }
    setTplDeleteTarget(null);
    setTick((t) => t + 1);
  };
  const openRename = (e: Employee) => { setRenameTarget(e); setRenameDraft(e.name); setRenameErr(""); };
  const submitRename = () => {
    if (!renameTarget) return;
    const r = renameEmployee(renameTarget.id, renameDraft);
    if (!r.ok) { setRenameErr(r.error); return; }
    setRenameTarget(null);
    setTick((t) => t + 1);
  };
  const openDelete = (e: Employee) => { setDeleteTarget(e); setDeleteErr(""); };
  const submitDelete = () => {
    if (!deleteTarget) return;
    const r = deleteEmployee(deleteTarget.id);
    if (!r.ok) { setDeleteErr(r.error); return; }
    setDeleteTarget(null);
    setTick((t) => t + 1);
  };
  // PRD-004 v1.1：未配置审核模型 + 下拉选了自动审核 → 降级人工徽标（禁静默顶替）。
  const autoReviewOn = isAutoReviewEnabled();
  const autoReviewConfigured = !!(autoReviewModel?.value?.provider && autoReviewModel?.value?.model);

  const employees = useMemo(() => loadEmployees(), [tick]);
  const tasks = useMemo(() => listTaskCards(), [tick]);
  const admits = useMemo(() => listPendingAdmits(), [tick, approvalOpen]);
  // 任务#1：岗位模板全量（内置 6 + 自定义≤20，localStorage），员工创建下拉同源。
  const roleTemplates = useMemo(() => listAllRoleTemplates(), [tick]);
  const customRoles = useMemo(() => loadCustomRoleTemplates(), [tick]);

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
        <div className="sd-pane-title">
          团队黑板（只读聚合）
          <span className="badge gray" style={{ marginLeft: 8 }}>0/{EMP_MAX_COUNT}</span>
          <button className="btn sm primary" style={{ marginLeft: 8 }} onClick={openCreate}>新建员工</button>
        </div>
        <div className="empty-state">未选团队（先创建员工并绑定会话）</div>
        <div className="queue-dock">
          <div className="queue-head">申请中心入口</div>
          <div className="queue-item">
            <span className="queue-text">待审批 {pendingTotal}（question 仅计数：{questionCount}）</span>
            <button className="btn sm" onClick={() => setApprovalOpen(true)}>进入申请中心</button>
          </div>
        </div>
        {approvalOpen && <ApprovalCenter onClose={() => { setApprovalOpen(false); setTick((t) => t + 1); }} />}
        {createOpen && (
          <div className="modal-mask" onClick={() => setCreateOpen(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h4>新建员工</h4>
              <div className="hint">名字 1-20 字，岗位单选；新建后归属为空（会话只经移交绑定），上限 {EMP_MAX_COUNT} 人。</div>
              <div className="field">
                <label>名称（必填，1-20 字）</label>
                <input type="text" value={createName} maxLength={EMP_NAME_MAX} autoFocus onChange={(e) => setCreateName(e.currentTarget.value)} />
              </div>
              <div className="field">
                <label>岗位（单选）</label>
                <select
                  value={createRole}
                  onChange={(e) => setCreateRole(e.currentTarget.value)}
                  style={{ width: "100%", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", fontSize: 13, background: "#fff" }}
                >
                  {roleTemplates.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              {createErr && <div className="field-err">{createErr}</div>}
              <div className="modal-row">
                <button className="btn sm" onClick={() => setCreateOpen(false)}>取消</button>
                <button className="btn sm primary" disabled={!createName.trim()} onClick={submitCreate}>创建</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="sd-panel">
      <div className="sd-pane-title">
        团队黑板（只读聚合）· 运行 {runningTotal} / 待审 {pendingTotal}
        {autoReviewOn && !autoReviewConfigured && <span className="badge cond" style={{ marginLeft: 8 }}>未配置审核模型，已降级人工</span>}
        <span className="badge gray" style={{ marginLeft: 8 }}>{employees.length}/{EMP_MAX_COUNT}</span>
        <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setTick((t) => t + 1)}>刷新</button>
        <button className="btn sm primary" style={{ marginLeft: 8 }} onClick={openCreate}>新建员工</button>
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
            const isSelected = selectedSessionId ? e.sessionIds.includes(String(selectedSessionId)) : false;
            const roleName = getRoleTemplate(e.role)?.name ?? e.role;
            return (
              <div className="queue-item" key={e.id} title={e.bio}>
                <span className={`dot${dot}`} />
                <span className="queue-text">
                  {e.avatar} {e.name}（{roleName} · 天花板 {e.ceiling}）
                  {phase ? ` · 目标 ${phase}` : ""} · 队列 {queueN} · 子代理 {runningSubs}
                  {awaiting > 0 && <span className="badge orange" style={{ marginLeft: 6 }}>待审 {awaiting}</span>}
                  {isSelected && <span className="badge def" style={{ marginLeft: 6 }}>选中</span>}
                  {e.sessionIds.length > 0 && <span className="badge gray" style={{ marginLeft: 6 }}>会话 {e.sessionIds.length}</span>}
                </span>
                <span style={{ display: "inline-flex", gap: 6, marginLeft: 8 }}>
                  <button className="btn sm" onClick={() => openRename(e)}>改名</button>
                  <button className="btn sm" onClick={() => openDelete(e)}>删除</button>
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

        {/* ①-2 岗位模板管理（任务#1：纯 localStorage，上限 20；重名大小写不敏感拒绝；被引用禁删） */}
        <div className="card" style={{ padding: 10 }}>
          <div className="queue-head">
            岗位模板管理
            <span className="badge gray" style={{ marginLeft: 8 }}>{customRoles.length}/{ROLE_MAX_COUNT}</span>
            <button className="btn sm primary" style={{ marginLeft: 8 }} onClick={openTplCreate}>新建岗位</button>
          </div>
          <div className="hint">内置 6 岗只读；自定义岗可增删改（名称 1-20 字，天花板固定 read-only），员工引用中禁删。可信直派默认关，仅可信无越界卡直派。</div>
          {roleTemplates.map((t) => {
            const isBuiltin = t.id === "frontend" || t.id === "backend" || t.id === "qa" || t.id === "pm" || t.id === "data" || t.id === "content";
            const refCount = employees.filter((e) => e.role === t.id).length;
            const trusted = getTrustedDispatch(t.id);
            return (
              <div className="queue-item" key={t.id} title={t.persona}>
                <span className={`badge ${isBuiltin ? "builtin" : "user"}`}>{isBuiltin ? "内置" : "自定义"}</span>
                <span className="queue-text">{t.name} · {t.persona}</span>
                {refCount > 0 && <span className="badge gray" style={{ marginLeft: 6 }}>引用 {refCount}</span>}
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8, fontSize: 12 }} title="可信直派：仅可信且无越界剔除卡直派，其余仍确认">
                  <input
                    type="checkbox"
                    checked={trusted}
                    onChange={(e) => {
                      setTrustedDispatch(t.id, e.currentTarget.checked);
                      setTick((tk) => tk + 1);
                    }}
                  />
                  可信直派
                </label>
                {trusted && <span className="badge cond" style={{ marginLeft: 6 }}>可信直派</span>}
                {!isBuiltin && (
                  <span style={{ display: "inline-flex", gap: 6, marginLeft: 8 }}>
                    <button className="btn sm" onClick={() => openTplEdit(t)}>编辑</button>
                    <button className="btn sm" onClick={() => openTplDelete(t)}>删除</button>
                  </span>
                )}
              </div>
            );
          })}
          {listTrustedLog().slice(0, 5).map((r, i) => (
            <div className="log-row log-info" key={`trust-${r.at}-${i}`}>
              <div className="log-row-main">
                <span className="log-msg">可信变更：{r.roleName} → {r.on ? "开" : "关"} · {new Date(r.at).toLocaleString("zh-CN")}</span>
              </div>
            </div>
          ))}
        </div>

        {/* ②任务卡墙（PRD-dispatch S4/S5：五段+状态 badge+证据 link 短id@seq，无证据通过 disabled） */}
        <div className="card" style={{ padding: 10 }}>
          <div className="queue-head">任务卡墙（{tasks.length}，上限并行 4 路）</div>
          {tasks.length === 0 && <div className="empty-state">暂无任务卡（团长拆解后下发）</div>}
          {tasks.map((t) => {
            const hasEvidence = !!(t.evidence?.sessionId && typeof t.evidence.seq === "number");
            const empName = employees.find((e) => e.id === t.assigneeEmployeeId)?.name ?? t.assigneeEmployeeId.slice(0, 8);
            return (
              <div className="queue-item" key={t.clientTaskId} title={`输入：${t.inputScope}｜输出：${t.outputTo}｜禁止：${t.forbidden}｜审批预期：${t.approvalNote}`} style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                <span className={`badge ${t.status === "todo" ? "gray" : t.status === "running" ? "cond" : t.status === "review" ? "orange" : t.status === "passed" ? "green" : "cond"}`}>
                  {t.status === "todo" ? (t.queued ? "排队" : "待派") : t.status === "running" ? "进行中" : t.status === "review" ? "待验收" : t.status === "passed" ? "通过" : "打回"}
                </span>
                <span className="queue-text" style={{ minWidth: 120 }}>
                  {t.title} · {empName}
                  {t.queued && <span className="badge cond" style={{ marginLeft: 6 }}>排队（超 4 路）</span>}
                </span>
                {hasEvidence ? (
                  <span className="queue-detail">{shortTeamId(t.evidence!.sessionId)}@{t.evidence!.seq}</span>
                ) : (
                  <span className="queue-detail" title="无证据不可标通过">无证据</span>
                )}
                <span style={{ display: "inline-flex", gap: 6, marginLeft: 8 }}>
                  <button
                    className="btn sm"
                    disabled={!hasEvidence || t.status === "passed"}
                    title={hasEvidence ? "挂 sessionId+seq 证据通过" : "无证据不可标通过（需挂 sessionId+seq 回流证据）"}
                    onClick={() => {
                      appStore.passDispatchCard(t.clientTaskId);
                      setTick((tk) => tk + 1);
                    }}
                  >
                    通过
                  </button>
                  <button
                    className="btn sm"
                    disabled={!hasEvidence || t.status === "rejected"}
                    title={hasEvidence ? "挂 sessionId+seq 证据打回" : "无证据不可打回（需挂 sessionId+seq 回流证据）"}
                    onClick={() => {
                      appStore.rejectDispatchCard(t.clientTaskId);
                      setTick((tk) => tk + 1);
                    }}
                  >
                    打回
                  </button>
                </span>
                <span className="queue-detail" style={{ width: "100%", wordBreak: "break-all" }}>
                  目标：{t.title}｜输入：{t.inputScope || "—"}｜输出：{t.outputTo || "—"}｜禁止：{t.forbidden || "—"}｜审批预期：{t.approvalNote || "—"}
                </span>
              </div>
            );
          })}
          <div style={{ marginTop: 6 }}>
            <button className="btn sm" onClick={() => { void appStore.refreshDispatchEvidence().then(() => setTick((tk) => tk + 1)); }}>刷新回流证据（≤5s 窗口）</button>
          </div>
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
      {createOpen && (
        <div className="modal-mask" onClick={() => setCreateOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h4>新建员工</h4>
            <div className="hint">名字 1-20 字，岗位单选；新建后归属为空（会话只经移交绑定），上限 {EMP_MAX_COUNT} 人。</div>
            <div className="field">
              <label>名称（必填，1-20 字）</label>
              <input type="text" value={createName} maxLength={EMP_NAME_MAX} autoFocus onChange={(e) => setCreateName(e.currentTarget.value)} />
            </div>
            <div className="field">
              <label>岗位（单选）</label>
              <select
                value={createRole}
                onChange={(e) => setCreateRole(e.currentTarget.value)}
                style={{ width: "100%", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", fontSize: 13, background: "#fff" }}
              >
                {roleTemplates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            {createErr && <div className="field-err">{createErr}</div>}
            <div className="modal-row">
              <button className="btn sm" onClick={() => setCreateOpen(false)}>取消</button>
              <button className="btn sm primary" disabled={!createName.trim()} onClick={submitCreate}>创建</button>
            </div>
          </div>
        </div>
      )}
      {tplCreateOpen && (
        <div className="modal-mask" onClick={() => setTplCreateOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h4>新建岗位模板</h4>
            <div className="hint">名称 1-20 字（大小写不敏感判重），人设/方法三条可选填，天花板固定 read-only，上限 {ROLE_MAX_COUNT} 个。</div>
            <div className="field">
              <label>名称（必填，1-20 字）</label>
              <input type="text" value={tplName} maxLength={ROLE_NAME_MAX} autoFocus onChange={(e) => setTplName(e.currentTarget.value)} />
            </div>
            <div className="field">
              <label>人设（可选）</label>
              <input type="text" value={tplPersona} onChange={(e) => setTplPersona(e.currentTarget.value)} placeholder="自定义岗位" />
            </div>
            <div className="field">
              <label>方法一</label>
              <input type="text" value={tplM1} onChange={(e) => setTplM1(e.currentTarget.value)} placeholder="遵守团队禁止事项" />
            </div>
            <div className="field">
              <label>方法二</label>
              <input type="text" value={tplM2} onChange={(e) => setTplM2(e.currentTarget.value)} placeholder="高风险动作转人工" />
            </div>
            <div className="field">
              <label>方法三</label>
              <input type="text" value={tplM3} onChange={(e) => setTplM3(e.currentTarget.value)} placeholder="留痕可审计" />
            </div>
            {tplErr && <div className="field-err">{tplErr}</div>}
            <div className="modal-row">
              <button className="btn sm" onClick={() => setTplCreateOpen(false)}>取消</button>
              <button className="btn sm primary" disabled={!tplName.trim()} onClick={submitTplCreate}>创建</button>
            </div>
          </div>
        </div>
      )}
      {tplEditTarget && (
        <div className="modal-mask" onClick={() => setTplEditTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h4>编辑岗位模板</h4>
            <div className="hint">仅改名称/人设/方法三条；编号/天花板不可改，不记移交审计。</div>
            <div className="field">
              <label>名称（必填，1-20 字）</label>
              <input type="text" value={tplEditName} maxLength={ROLE_NAME_MAX} autoFocus onChange={(e) => setTplEditName(e.currentTarget.value)} />
            </div>
            <div className="field">
              <label>人设</label>
              <input type="text" value={tplEditPersona} onChange={(e) => setTplEditPersona(e.currentTarget.value)} />
            </div>
            <div className="field">
              <label>方法一</label>
              <input type="text" value={tplEditM1} onChange={(e) => setTplEditM1(e.currentTarget.value)} />
            </div>
            <div className="field">
              <label>方法二</label>
              <input type="text" value={tplEditM2} onChange={(e) => setTplEditM2(e.currentTarget.value)} />
            </div>
            <div className="field">
              <label>方法三</label>
              <input type="text" value={tplEditM3} onChange={(e) => setTplEditM3(e.currentTarget.value)} />
            </div>
            {tplEditErr && <div className="field-err">{tplEditErr}</div>}
            <div className="modal-row">
              <button className="btn sm" onClick={() => setTplEditTarget(null)}>取消</button>
              <button className="btn sm primary" disabled={!tplEditName.trim()} onClick={submitTplEdit}>保存</button>
            </div>
          </div>
        </div>
      )}
      {tplDeleteTarget && (
        <div className="modal-mask" onClick={() => setTplDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h4>删除岗位模板</h4>
            <div className="hint">删除岗位模板「{tplDeleteTarget.name}」？此操作不可恢复</div>
            {tplDeleteErr && <div className="field-err">{tplDeleteErr}</div>}
            <div className="modal-row">
              <button className="btn sm" onClick={() => setTplDeleteTarget(null)}>取消</button>
              <button className="btn sm primary" onClick={submitTplDelete}>确认删除</button>
            </div>
          </div>
        </div>
      )}
      {renameTarget && (
        <div className="modal-mask" onClick={() => setRenameTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h4>改名员工</h4>
            <div className="hint">仅改名称（头像随首字联动）；编号/岗位/天花板/会话不可改，不记移交审计。</div>
            <div className="field">
              <label>名称（必填，1-20 字）</label>
              <input type="text" value={renameDraft} maxLength={EMP_NAME_MAX} autoFocus onChange={(e) => setRenameDraft(e.currentTarget.value)} />
            </div>
            {renameErr && <div className="field-err">{renameErr}</div>}
            <div className="modal-row">
              <button className="btn sm" onClick={() => setRenameTarget(null)}>取消</button>
              <button className="btn sm primary" disabled={!renameDraft.trim()} onClick={submitRename}>保存</button>
            </div>
          </div>
        </div>
      )}
      {deleteTarget && (
        <div className="modal-mask" onClick={() => setDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h4>删除员工</h4>
            {deleteTarget.sessionIds.length > 0 ? (
              <>
                <div className="field-err">{`该员工名下还有${deleteTarget.sessionIds.length}个会话，请先移交/解绑后再删除`}</div>
                {deleteErr && <div className="field-err">{deleteErr}</div>}
                <div className="modal-row">
                  <button className="btn sm" onClick={() => setDeleteTarget(null)}>关闭</button>
                </div>
              </>
            ) : (
              <>
                <div className="hint">删除员工「{deleteTarget.name}」？此操作不可恢复</div>
                {deleteErr && <div className="field-err">{deleteErr}</div>}
                <div className="modal-row">
                  <button className="btn sm" onClick={() => setDeleteTarget(null)}>取消</button>
                  <button className="btn sm primary" onClick={submitDelete}>确认删除</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
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
