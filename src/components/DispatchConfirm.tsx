import { useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import { loadEmployees, shortTeamId } from "../lib/team";

/**
 * DispatchConfirm — PRD-dispatch S3 人工确认卡。
 * 复用 modal-mask z200 + modal-wide 680px 系（让位 loading z500）；N 卡纵排每卡 queue-item 行+五段 field；
 * 改派下拉（复用 field/select，同团队存活员工）/减卡 btn sm/取消；直派卡顶置 badge green“已直派免确认”+灰化；
 * 超 4 路排队行 badge cond；确认后才 claimClientTaskId 双域幂等领取。
 */
export function DispatchConfirm() {
  const { pendingDispatch, dispatchBusy } = useAppState();
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  if (!pendingDispatch) return null;
  const employees = loadEmployees();
  const directSet = new Set(pendingDispatch.directCardIds);
  const directCards = pendingDispatch.cards.filter((c) => directSet.has(c.clientTaskId));
  const normalCards = pendingDispatch.cards.filter((c) => !directSet.has(c.clientTaskId));
  const visible = normalCards.filter((c) => !removed.has(c.clientTaskId));
  const parallel = visible.filter((c) => !c.queued).length;

  const toggleRemove = (id: string) => {
    setRemoved((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = async () => {
    if (busy || dispatchBusy) return;
    setBusy(true);
    try {
      await appStore.confirmDispatch({ assignee: assign, removedIds: [...removed] });
      setAssign({});
      setRemoved(new Set());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={() => appStore.cancelDispatch()}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="分派确认卡">
        <h4>分派确认（{visible.length} 卡 · 并行 {Math.min(parallel, 4)} 路{visible.some((c) => c.queued) ? " · 超 4 路排队" : ""}）</h4>
        <div className="hint">默认确认后才分派；确认后才写 clientTaskId 幂等领取（同卡重发拒绝+notice）。改派仅允许同团队内存活员工。</div>
        {pendingDispatch.directCardIds.length > 0 && (
          <div className="queue-item">
            <span className="badge green">已直派免确认</span>
            <span className="queue-text">{pendingDispatch.directCardIds.length} 张可信卡已直派（trustedDispatch 且无越界剔除）</span>
            <span className="queue-detail">{pendingDispatch.directCardIds.map((id) => shortTeamId(id)).join("、")}</span>
          </div>
        )}
        {directCards.map((c) => (
          <div className="card" key={c.clientTaskId} style={{ padding: 10, marginBottom: 8, opacity: 0.6 }}>
            <div className="queue-item">
              <span className="badge green">已直派免确认</span>
              <span className="queue-text" style={{ wordBreak: "break-all" }}>{c.title} → {c.assigneeName ?? ""}</span>
              <span className="queue-detail">{shortTeamId(c.clientTaskId)}</span>
            </div>
            <div className="hint">该卡已直派执行，不可编辑/减卡（灰化）；其余卡仍可改派/减卡/取消。</div>
          </div>
        ))}
        {normalCards.filter((c) => !removed.has(c.clientTaskId)).length === 0 && (
          <div className="empty-state">已全部减卡（确认即取消，不产生新会话）</div>
        )}
        {normalCards.map((c) => {
          const isRemoved = removed.has(c.clientTaskId);
          const assignee = assign[c.clientTaskId] ?? c.assigneeEmployeeId ?? "";
          return (
            <div className="card" key={c.clientTaskId} style={{ padding: 10, marginBottom: 8, opacity: isRemoved ? 0.5 : 1 }}>
              <div className="queue-item">
                <span className="badge gray">{shortTeamId(c.clientTaskId)}</span>
                <span className="queue-text" style={{ wordBreak: "break-all" }}>{c.title}</span>
                {c.queued && <span className="badge cond">排队（超 4 路）</span>}
                {c.hasViolation && <span className="badge cond">越界剔除</span>}
                <button className="btn sm" disabled={busy} onClick={() => toggleRemove(c.clientTaskId)}>{isRemoved ? "恢复" : "减卡"}</button>
              </div>
              <div className="provider-list" style={{ marginTop: 6 }}>
                <div className="kv"><span className="k">目标</span><span className="v" style={{ wordBreak: "break-all" }}>{c.title}</span></div>
                <div className="kv"><span className="k">输入范围</span><span className="v" style={{ wordBreak: "break-all" }}>{c.inputScope || "—"}</span></div>
                <div className="kv"><span className="k">输出位置</span><span className="v" style={{ wordBreak: "break-all" }}>{c.outputTo || "—"}</span></div>
                <div className="kv"><span className="k">禁止事项</span><span className="v" style={{ wordBreak: "break-all" }}>{c.forbidden || "—"}</span></div>
                <div className="kv"><span className="k">审批预期</span><span className="v" style={{ wordBreak: "break-all" }}>{c.approvalNote || "—"}</span></div>
                <div className="kv"><span className="k">建议 assignee</span><span className="v">{c.suggestedAssignee || "（模型未建议，按 role/skill 确定性匹配）"} → 确定性匹配：{c.assigneeName ?? "（无可用员工）"}</span></div>
                {c.eliminated.length > 0 && (
                  <div className="kv"><span className="k">剔除说明</span><span className="v" style={{ wordBreak: "break-all" }}>{c.eliminated.map((e) => `${e.employeeName}：${e.reason}`).join("；")}</span></div>
                )}
                {c.violationReasons.length > 0 && (
                  <div className="kv"><span className="k">越界项</span><span className="v" style={{ wordBreak: "break-all" }}>{c.violationReasons.join("；")}</span></div>
                )}
                <div className="field" style={{ marginTop: 6 }}>
                  <label>改派（同团队存活员工）</label>
                  <select value={assignee} disabled={isRemoved || employees.length === 0} onChange={(e) => setAssign((m) => ({ ...m, [c.clientTaskId]: e.currentTarget.value }))}>
                    <option value="">（保持 {c.assigneeName ?? "未分配"}）</option>
                    {employees.map((e) => (
                      <option key={e.id} value={e.id}>{e.name}（{(e.skillSnapshot ?? []).join(",") || e.role}）</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          );
        })}
        <div className="modal-row">
          <button className="btn" disabled={busy} onClick={() => appStore.cancelDispatch()}>取消</button>
          <button className="btn primary" disabled={busy || dispatchBusy} onClick={() => void confirm()}>确认分派</button>
        </div>
      </div>
    </div>
  );
}
