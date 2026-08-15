import { useEffect, useState } from "react";
import { dsh, wsl, type WslStatus } from "../lib/tauri";
import { appStore, useAppState } from "../lib/dsh/store";

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

  const load = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const s = await wsl.status();
      setStatus(s);
      if (s.available) {
        setDistro(config?.wsl_default_distro ?? s.default_distro ?? "");
      } else {
        setDistro(config?.wsl_default_distro ?? "");
      }
      setDshHome(config?.wsl_dsh_home ?? "");
      setWorkspaceDir(config?.wsl_workspace_dir ?? "");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.wsl_default_distro, config?.wsl_dsh_home, config?.wsl_workspace_dir]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await wsl.saveConfig(distro || null, dshHome || null, workspaceDir || null);
      const cfg = await dsh.getConfig();
      appStore.set({ config: cfg });
      setConfirm(false);
      setMsg("WSL 配置已保存（写前已校验发行版与路径；config.json 留有备份）");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setSaving(false);
    }
  };

  const unavailable = status !== null && (!status.available || !status.windows);

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">DSH WSL 配置与连接</span>
        <button className="btn sm" disabled={loading} onClick={() => void load()}>{loading ? "检测中…" : "重新检测"}</button>
      </div>

      {status === null && !msg && <div className="empty-state">检测 WSL 状态…</div>}
      {msg && <div className="error-banner" style={{ margin: "0 0 10px" }}>{msg}</div>}

      {status && (
        <>
          <div className="kv"><span className="k">WSL 可用</span><span className="v">{status.available ? "是" : "否"}</span></div>
          {status.reason && <div className="kv"><span className="k">不可用原因</span><span className="v">{status.reason}</span></div>}
          {status.default_distro && <div className="kv"><span className="k">默认发行版</span><span className="v">{status.default_distro}</span></div>}
          {status.kernel && <div className="kv"><span className="k">内核</span><span className="v">{status.kernel}</span></div>}
          {status.wsl_version && <div className="kv"><span className="k">WSL</span><span className="v">{status.wsl_version}</span></div>}

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
              当前环境无 WSL，配置已停用；应用主流程不受影响。请先安装 WSL（wsl --install）后重试。
            </div>
          ) : (
            <>
              <div className="f-label">目标发行版</div>
              <select value={distro} onChange={(e) => setDistro(e.currentTarget.value)}>
                <option value="">（默认发行版）</option>
                {status.distros.map((d) => (
                  <option key={d.name} value={d.name}>{d.name}</option>
                ))}
              </select>
              <div className="f-label">WSL 内 DSH_HOME（\\wsl$\&lt;发行版&gt;\…）</div>
              <input type="text" value={dshHome} onChange={(e) => setDshHome(e.currentTarget.value)} placeholder={'例如 \\\\wsl$\\CodexUbuntu\\home\\user\\.dsh'} />
              <div className="f-label">WSL 工作区目录（\\wsl$\&lt;发行版&gt;\…）</div>
              <input type="text" value={workspaceDir} onChange={(e) => setWorkspaceDir(e.currentTarget.value)} placeholder={'例如 \\\\wsl$\\CodexUbuntu\\home\\user\\projects'} />
              <div className="hint" style={{ marginTop: 8 }}>
                写操作遵循：最小权限（仅写应用 config.json，不改系统配置）、用户确认（下方按钮二次确认）、失败可恢复（保存前自动备份 config.json）。路径与发行版在写入前校验。
              </div>
              <div className="actions">
                <button className="btn primary" onClick={() => setConfirm(true)}>保存 WSL 配置（需确认）</button>
              </div>
            </>
          )}
        </>
      )}

      {confirm && (
        <div className="modal-mask" onClick={() => setConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h4>确认保存 WSL 配置？</h4>
            <div className="hint">
              将写入：发行版 = {distro || "（默认）"}，DSH_HOME = {dshHome || "（未设置）"}，工作区 = {workspaceDir || "（未设置）"}。
              写入前校验发行版存在、路径可访问；保存前备份 config.json。
            </div>
            <div className="modal-row">
              <button className="btn" onClick={() => setConfirm(false)}>取消</button>
              <button className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "确认保存"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
