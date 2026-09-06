import { useEffect, useState } from "react";
import {
  dsh,
  wsl,
  onWslProvision,
  type WslProvisionStep,
  type WslStatus,
} from "../lib/tauri";
import { appStore, useAppState } from "../lib/dsh/store";
import { withLoading, isDedupError, isCancelError } from "../lib/loading";
import { logger } from "../lib/logger";

export function WslPanel() {
  const { config } = useAppState();
  const [status, setStatus] = useState<WslStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [distro, setDistro] = useState("");
  const [dshHome, setDshHome] = useState("");
  const [workspaceDir, setWorkspaceDir] = useState("");
  const [provisioning, setProvisioning] = useState(false);
  const [provisionConfirm, setProvisionConfirm] = useState(false);
  const [provisionSteps, setProvisionSteps] = useState<WslProvisionStep[]>([]);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setMsg(null);
    try {
      // PRD-002：可取消只读组；>800ms 必现 overlay，<800ms 仅局部“检测中…”。
      const s = await withLoading("wsl_status_cmd", "正在检测 WSL 状态…", () => wsl.status(), {
        stage: "正在检测…",
      });
      setStatus(s);
      if (s.available) {
        setDistro(config?.wsl_default_distro ?? s.default_distro ?? "");
      } else {
        setDistro(config?.wsl_default_distro ?? "");
      }
      setDshHome(config?.wsl_dsh_home ?? "");
      setWorkspaceDir(config?.wsl_workspace_dir ?? "");
    } catch (e) {
      if (isDedupError(e) || isCancelError(e)) return;
      setMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.wsl_default_distro, config?.wsl_dsh_home, config?.wsl_workspace_dir]);

  useEffect(() => {
    const un = onWslProvision((s) =>
      setProvisionSteps((prev) => [...prev, s]),
    ).catch(() => undefined);
    return () => {
      void un.then((fn) => fn?.());
    };
  }, []);

  const provision = async () => {
    setProvisionConfirm(false);
    setProvisioning(true);
    setProvisionError(null);
    setProvisionSteps([]);
    try {
      // PRD-002：不可取消组 in-flight（置灰“最小化观察…”）；wsl://provision message 映射为阶段行 + 详情折叠区。
      const report = await withLoading(
        "wsl_provision_cmd",
        "正在创建 WSL 发行版…",
        async (_signal, rep) => {
          const unlisten = await onWslProvision((s) => {
            setProvisionSteps((prev) => [...prev, s]);
            rep(s.message, `[${s.status}] ${s.message}`);
          }).catch(() => undefined);
          try {
            return await wsl.provision(distro || null, null);
          } finally {
            if (typeof unlisten === "function") unlisten();
          }
        },
        { stage: "正在准备…", args: { distro: distro || null } },
      );
      if (report.ok) {
        setDistro(report.distro ?? "");
        setDshHome(report.dsh_home ?? "");
        setWorkspaceDir(report.workspace_dir ?? "");
        const cfg = await dsh.getConfig();
        appStore.set({ config: cfg });
        setMsg("准备完成：所选 Linux 系统已装好 DSH 并完成绑定，失败会在下方红条显示原因");
        logger.info("wsl", "一键创建/初始化完成");
        await load();
      } else {
        setProvisionError(report.error ?? "安装失败：见上方日志，修好后点“检测并安装 DSH”重试");
      }
    } catch (e) {
      if (isDedupError(e) || isCancelError(e)) return;
      setProvisionError(String(e instanceof Error ? e.message : e));
    } finally {
      setProvisioning(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      // PRD-002：不可取消组（写 config），tooltip 明示。
      await withLoading(
        "wsl_save_config_cmd",
        "正在保存 WSL 配置…",
        () => wsl.saveConfig(distro || null, dshHome || null, workspaceDir || null),
        { stage: "正在准备…", args: { distro, dshHome, workspaceDir } },
      );
      const cfg = await dsh.getConfig();
      appStore.set({ config: cfg });
      setConfirm(false);
      setMsg("绑定已保存：所选系统和路径已校验并自动备份，成功可直接用 WSL 运行，失败会显示原因");
      logger.info("wsl", "WSL 配置已保存");
    } catch (e) {
      if (isDedupError(e) || isCancelError(e)) return;
      setMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  const unavailable = status !== null && (!status.available || !status.windows);

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">WSL 连接：在 Linux 子系统里运行 DSH</span>
        <button className="btn sm" disabled={loading} onClick={() => void load()}>{loading ? "正在检测…" : "检测 WSL 状态"}</button>
      </div>

      {status === null && !msg && <div className="empty-state">正在检测 WSL 是否可用，成功会列出 Linux 系统，失败会显示原因…</div>}
      {msg && <div className="error-banner" title={msg} style={{ margin: "0 0 10px", userSelect: "text" }}>{msg}</div>}

      {status && (
        <>
          <div className="kv"><span className="k">WSL 状态</span><span className="v">{status.available ? "可用" : "不可用（见下方说明）"}</span></div>
          {status.reason && <div className="kv"><span className="k">不可用原因（修好后点“检测 WSL 状态”重试）</span><span className="v">{status.reason}</span></div>}
          {status.default_distro && <div className="kv"><span className="k">默认 Linux 系统（发行版，不选时就用它）</span><span className="v">{status.default_distro}</span></div>}
          {status.kernel && <div className="kv"><span className="k">内核版本</span><span className="v">{status.kernel}</span></div>}
          {status.wsl_version && <div className="kv"><span className="k">WSL 版本</span><span className="v">{status.wsl_version}</span></div>}

          {status.distros.length > 0 && (
            <div className="list" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 4, margin: "8px 0" }}>
              {status.distros.map((d) => (
                <div className="list-item" key={d.name}>
                  <span className="title">{d.name}{d.is_default ? "（默认）" : ""}</span>
                  <span className={`badge ${d.state.toLowerCase() === "running" ? "green" : "gray"}`}>{d.state}</span>
                  <span className="sub">WSL {d.version}</span>
                </div>
              ))}
            </div>
          )}

          {unavailable ? (
            <div className="empty-state" style={{ textAlign: "left", padding: "12px 0" }}>
              当前没检测到 WSL，本区已停用但不影响 Windows 直连使用；成功是上方显示“可用”，失败请用管理员终端运行 wsl --install 后点“检测 WSL 状态”重试。
            </div>
          ) : (
            <>
              <div className="section-divider" style={{ margin: "12px 0 8px" }}>
                <span className="title">一键准备 Linux 环境</span>
              </div>
              <div className="hint" style={{ marginBottom: 8 }}>
                点“检测并安装 DSH”即可准备所选 Linux 系统：没有就新建一个 Ubuntu，有就直接复用并装好 Node 20+ 和 DSH；成功提示“准备完成”，失败下方红条显示原因。
              </div>
              <div className="actions">
                <button
                  className="btn primary"
                  disabled={provisioning}
                  onClick={() => setProvisionConfirm(true)}
                >
                  {provisioning ? "正在安装…（进度见下方日志）" : "检测并安装 DSH"}
                </button>
              </div>
              {provisionError && (
                <div className="error-banner" title={provisionError} style={{ margin: "8px 0", userSelect: "text" }}>{provisionError}</div>
              )}
              {provisionSteps.length > 0 && (
                <div
                  className="list"
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: 6,
                    margin: "8px 0",
                    maxHeight: 220,
                    overflowY: "auto",
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                  }}
                >
                  {provisionSteps.map((s, i) => (
                    <div key={i} className="provision-line">
                      <span className={`badge ${s.status === "error" ? "red" : s.status === "ok" ? "green" : "gray"}`}>
                        {s.status}
                      </span>
                      <span className="sub">{s.message}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="f-label">要用的 Linux 系统（发行版，不选就用默认）</div>
              <select value={distro} onChange={(e) => setDistro(e.currentTarget.value)}>
                <option value="">（用默认系统）</option>
                {status.distros.map((d) => (
                  <option key={d.name} value={d.name}>{d.name}</option>
                ))}
              </select>
              <div className="f-label">DSH 存配置的文件夹（DSH_HOME，格式 \\wsl$\系统名\…）</div>
              <input type="text" value={dshHome} onChange={(e) => setDshHome(e.currentTarget.value)} placeholder={'例如 \\\\wsl$\\CodexUbuntu\\home\\user\\.dsh'} />
              <div className="f-label">放代码的工作区文件夹（WSL 里能打开的路径，格式同上）</div>
              <input type="text" value={workspaceDir} onChange={(e) => setWorkspaceDir(e.currentTarget.value)} placeholder={'例如 \\\\wsl$\\CodexUbuntu\\home\\user\\projects'} />
              <div className="hint" style={{ marginTop: 8 }}>
                点“保存绑定”只改本应用设置并自动备份，成功提示“已保存”，失败会弹出原因，不会改系统设置。
              </div>
              <div className="actions">
                <button className="btn primary" onClick={() => setConfirm(true)}>保存绑定</button>
              </div>
            </>
          )}
        </>
      )}

      {confirm && (
        <div className="modal-mask" onClick={() => setConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h4>确认保存绑定？</h4>
            <div className="hint">
              点“确认绑定”会保存：系统 = {distro || "（默认）"}，DSH_HOME = {dshHome || "（未设置）"}，工作区 = {workspaceDir || "（未设置）"}；成功提示“已保存”，失败会显示原因并保留原设置。
            </div>
            <div className="modal-row">
              <button className="btn" onClick={() => setConfirm(false)}>取消</button>
              <button className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? "正在保存…" : "确认绑定"}</button>
            </div>
          </div>
        </div>
      )}

      {provisionConfirm && (
        <div className="modal-mask" onClick={() => setProvisionConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h4>确认检测并安装 DSH？</h4>
            <div className="hint">
              点“确认安装”会在所选 Linux 系统里装好 Node 20+ 和 DSH；成功提示“准备完成”并自动绑定，失败红条显示原因。
            </div>
            <div className="modal-row">
              <button className="btn" onClick={() => setProvisionConfirm(false)}>取消</button>
              <button className="btn primary" disabled={provisioning} onClick={() => void provision()}>
                {provisioning ? "正在安装…" : "确认安装"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
