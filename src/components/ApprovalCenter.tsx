import { useMemo, useState } from "react";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { appStore, useAppState } from "../lib/dsh/store";
import { dshStdHost } from "../lib/tauri";
import {
  APPROVAL_TIMEOUT_SECS,
  exportAuditJson,
  isApprovalTimedOut,
  listAuditRows,
  listPendingAdmits,
  markHumanDecided,
  redactSecrets,
  resolvePluginAdmit,
} from "../lib/team";
import { shortId } from "./ui";

/**
 * ApprovalCenter — 申请中心 modal（复用 modal-mask z200，让位 Loading z500）。
 * 双源队列：dsh-approval（store.interactives）+ plugin-admit（内存注册表）。
 * 自动三判结果进审计行（内存 + 手动导出）；回滚全复用现 invoke：
 * grant_set 空 / uninstall / fork@seq + fs_revert / settings.mutate 回快照。
 * 超时 60s：保持待判 + 置顶 + notice，不自动批。声音默认关（仅横幅）。
 */
export function ApprovalCenter({ onClose }: { onClose: () => void }) {
  const { interactives, sessions, host } = useAppState();
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  const pending = useMemo(
    () =>
      interactives
        .filter((i) => i.kind === "approval" && i.frame.type === "approval/requested")
        .map((i) => {
          const fr = i.frame as unknown as { approvalId: string; sessionId: SessionId; toolName?: string; reason?: string };
          return {
            key: i.rpcId,
            approvalId: fr.approvalId,
            sessionId: fr.sessionId,
            toolName: fr.toolName ?? "unknown",
            reason: fr.reason ?? "",
            timedOut: isApprovalTimedOut(fr.approvalId),
            item: i,
          };
        })
        .sort((a, b) => Number(b.timedOut) - Number(a.timedOut)),
    [interactives],
  );
  const admits = useMemo(() => listPendingAdmits(), [tick]);
  const audits = useMemo(() => listAuditRows(), [tick, interactives]);
  void sessions;
  void host;

  const decide = async (key: string, approvalId: string, outcome: "allowed-once" | "rejected") => {
    const target = interactives.find((i) => i.rpcId === key);
    if (!target) return;
    setBusy(key);
    try {
      await appStore.answerApproval(target, outcome);
      markHumanDecided(approvalId);
    } finally {
      setBusy(null);
      setTick((t) => t + 1);
    }
  };

  /** 插件 admit 人工决：允许 = grant_set 原权限（人工确认），拒绝 = grant_set 空（空即拒，冻结语义）。 */
  const decideAdmit = async (pluginId: string, allow: boolean, perms: string[]) => {
    setBusy(pluginId);
    try {
      await dshStdHost.grantSet(pluginId, allow ? perms : []);
      resolvePluginAdmit(pluginId);
    } catch (e) {
      appStore.set({ error: `插件授权失败: ${String(e)}` });
    } finally {
      setBusy(null);
      setTick((t) => t + 1);
    }
  };

  /** 回滚：插件授权撤销（grant_set 空，复用现 invoke，不新增）。 */
  const revokePlugin = async (pluginId: string) => {
    setBusy(`revoke-${pluginId}`);
    try {
      await dshStdHost.grantSet(pluginId, []);
      appStore.set({ notice: `已撤销插件 ${pluginId} 本次自动批准的授权（grant_set 空）` });
    } catch (e) {
      appStore.set({ error: `撤销失败: ${String(e)}` });
    } finally {
      setBusy(null);
      setTick((t) => t + 1);
    }
  };

  /** 回滚：会话内回退（fork@seq；文件回退走 retract 链的 fs_revert，需在会话内操作）。 */
  const rollbackSession = async (sessionId: string, seq?: number) => {
    const target = sessionId as unknown as SessionId;
    setBusy(`fork-${sessionId}`);
    try {
      if (seq !== undefined) {
        await appStore.forkAt(target, seq);
        appStore.set({ notice: `已回滚：fork@${seq} 新会话已建（派生自 ${shortId(target)}@${seq}），文件回退请在会话内用撤回链 fs_revert` });
      } else {
        appStore.set({ error: "无 seq 证据，不可回滚（无证据不执行）" });
      }
    } finally {
      setBusy(null);
      setTick((t) => t + 1);
    }
  };

  /** 回滚：默认预设回快照值（仅允许回到员工创建快照，不抬高）。 */
  const rollbackPreset = async (snapshot: string) => {
    setBusy(`preset-${snapshot}`);
    try {
      await appStore.setDefaultPermissionPreset(snapshot);
      appStore.set({ notice: `默认预设已回滚到快照 ${snapshot}（未抬高）` });
    } finally {
      setBusy(null);
      setTick((t) => t + 1);
    }
  };

  /** 批量撤销：仅自动批准可批量，人工已决需逐条确认（冻结）。 */
  const batchRevokeAuto = async () => {
    const autoPlugins = audits.filter((r) => r.verdict === "auto-allow" && r.source === "plugin-admit");
    if (autoPlugins.length === 0) {
      appStore.set({ notice: "本次无自动批准的插件授权可批量撤销" });
      return;
    }
    for (const r of autoPlugins) {
      try {
        await dshStdHost.grantSet(r.evidence.sessionId, []);
      } catch {
        // 逐个尽力撤销，失败留 error 横幅
        appStore.set({ error: `批量撤销部分失败：${r.requestId}` });
        break;
      }
    }
    try {
      await dshStdHost.grants();
    } catch {
      // 只读复核失败不阻断
    }
    setTick((t) => t + 1);
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} style={{ width: "min(680px, calc(100vw - 48px))" }}>
        <header>申请中心 · 待判 {pending.length + admits.length}（超时 {APPROVAL_TIMEOUT_SECS}s 置顶不自动批）</header>
        <div className="modal-body">
          {pending.length === 0 && admits.length === 0 && <div className="empty-state">暂无待审批申请</div>}
          {pending.map((p) => (
            <div className={`log-row ${p.timedOut ? "log-error" : "log-warn"}`} key={p.key}>
              <div className="log-row-main">
                <span className="badge gray">dsh-approval</span>
                {p.timedOut && <span className="badge cond">超时待判·已置顶</span>}
                <span className="log-msg">
                  {p.toolName} · {shortId(p.sessionId)} · {redactSecrets(p.reason).slice(0, 120) || "(无 reason)"}
                </span>
                <span className="log-row-ops">
                  <button className="btn sm primary" disabled={busy === p.key} onClick={() => void decide(p.key, p.approvalId, "allowed-once")}>允许一次</button>
                  <button className="btn sm danger-o" disabled={busy === p.key} onClick={() => void decide(p.key, p.approvalId, "rejected")}>拒绝</button>
                </span>
              </div>
            </div>
          ))}
          {admits.map((a) => (
            <div className="log-row log-warn" key={a.pluginId}>
              <div className="log-row-main">
                <span className="badge gray">plugin-admit</span>
                <span className="log-msg">{a.manifestName}（{a.pluginId}）· 申请 {a.requestedPermissions.length} 项权限</span>
                <span className="log-row-ops">
                  <button className="btn sm primary" disabled={busy === a.pluginId} onClick={() => void decideAdmit(a.pluginId, true, a.requestedPermissions)}>批准</button>
                  <button className="btn sm danger-o" disabled={busy === a.pluginId} onClick={() => void decideAdmit(a.pluginId, false, [])}>拒绝（grant_set 空）</button>
                </span>
              </div>
            </div>
          ))}

          <div className="queue-head" style={{ marginTop: 12 }}>审计行（内存 + 手动导出；reason 已脱敏 ****）</div>
          {audits.length === 0 && <div className="empty-state">暂无审计行（自动三判/人工决后写入）</div>}
          {audits.map((r) => (
            <div className={`log-row ${r.verdict === "auto-deny" ? "log-error" : r.verdict === "auto-allow" ? "log-info" : ""}`} key={`${r.requestId}-${r.decidedAt}`}>
              <div className="log-row-main">
                <span className={`badge ${r.verdict === "auto-allow" ? "green" : r.verdict === "auto-deny" ? "cond" : "gray"}`}>
                  {r.verdict === "auto-allow" ? "自动批准" : r.verdict === "auto-deny" ? "自动拒绝" : r.verdict === "to-human" ? "转人工" : r.verdict === "human-decided" ? "人工已决" : "已过期"}
                </span>
                <span className="log-msg">
                  {r.policyRowId} · 天花板 {r.ceiling} · {new Date(r.decidedAt).toLocaleTimeString()} · 证据 {shortId(r.evidence.sessionId)}
                  {r.evidence.seq !== undefined ? `@${r.evidence.seq}` : ""} · {r.reasonRedacted.slice(0, 100)}
                </span>
                <span className="log-row-ops">
                  {r.source === "plugin-admit" && r.verdict === "auto-allow" && (
                    <button className="btn sm" disabled={busy === `revoke-${r.evidence.sessionId}`} onClick={() => void revokePlugin(r.evidence.sessionId)}>回滚</button>
                  )}
                  {r.source === "dsh-approval" && r.verdict === "auto-allow" && (
                    <button className="btn sm" disabled={busy === `fork-${r.evidence.sessionId}`} onClick={() => void rollbackSession(r.evidence.sessionId, r.evidence.seq)}>回滚</button>
                  )}
                  {r.policyRowId.startsWith("preset-") && (
                    <button className="btn sm" disabled={busy === `preset-${r.ceiling}`} onClick={() => void rollbackPreset(r.ceiling)}>回快照</button>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
        <footer style={{ display: "flex", gap: 8, justifyContent: "flex-end", padding: 12 }}>
          <button className="btn sm" onClick={batchRevokeAuto}>撤销本次自动批准</button>
          <button className="btn sm" onClick={exportAuditJson}>手动导出审计</button>
          <button className="btn sm" onClick={onClose}>关闭</button>
        </footer>
      </div>
    </div>
  );
}
