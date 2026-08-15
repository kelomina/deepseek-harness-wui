import { useCallback, useEffect, useState } from "react";
import { dsh, runtime, type RuntimeView, type VerifyReport } from "../lib/tauri";
import { appStore } from "../lib/dsh/store";

const REPO_VERSION = "0.1.0-rc.6";

export function RuntimeManager({ running }: { running: boolean }) {
  const [list, setList] = useState<RuntimeView[] | null>(null);
  const [remote, setRemote] = useState<string[] | null>(null);
  const [installVersion, setInstallVersion] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [verifyMap, setVerifyMap] = useState<Record<string, VerifyReport | null>>({});
  const [confirmRemove, setConfirmRemove] = useState<RuntimeView | null>(null);

  const refresh = useCallback(async () => {
    try {
      setList(await runtime.list());
    } catch (e) {
      setMsg(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fetchRemote = async () => {
    setBusy("remote");
    setMsg(null);
    try {
      setRemote(await runtime.remoteVersions());
    } catch (e) {
      setMsg(`获取远程版本失败: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    const v = installVersion.trim();
    if (!v) return;
    setBusy(`install-${v}`);
    setMsg(null);
    try {
      const view = await runtime.install(v);
      setMsg(`已安装 ${view.version}（integrity 校验通过）`);
      setInstallVersion("");
      await refresh();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const verify = async (version: string) => {
    setBusy(`verify-${version}`);
    setMsg(null);
    try {
      const report = await runtime.verify(version);
      setVerifyMap((m) => ({ ...m, [version]: report }));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const setActive = async (version: string | null) => {
    setBusy(`active-${version ?? "none"}`);
    setMsg(null);
    try {
      await runtime.setActive(version);
      await refresh();
      const cfg = await dsh.getConfig();
      appStore.set({ config: cfg });
      setMsg(version ? `已启用受管运行时 ${version}（下次启动 dsh 生效）` : "已恢复仓库 bundled 运行时（下次启动 dsh 生效）");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (version: string) => {
    setBusy(`remove-${version}`);
    setMsg(null);
    try {
      const backup = await runtime.remove(version);
      setMsg(`已移除 ${version}（可回滚，备份位于 ${backup}）`);
      setConfirmRemove(null);
      await refresh();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const rollback = async (version: string) => {
    setBusy(`rollback-${version}`);
    setMsg(null);
    try {
      await runtime.rollback(version);
      setMsg(`已回滚 ${version}`);
      await refresh();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">DSH 运行时管理（下载 / 安装 / 校验 / 回滚）</span>
        <button className="btn sm" disabled={!!busy} onClick={() => void fetchRemote()}>获取可用版本</button>
      </div>
      <div className="hint" style={{ marginBottom: 10 }}>
        仓库 bundled 固定版本：{REPO_VERSION}。受管版本安装在应用配置目录 runtimes/&lt;version&gt;，启用后 Bundled 模式使用该版本；全部精确锁定，安装前强制 sha512（npm integrity）校验。
      </div>

      <div className="f-label">安装新版本（精确锁定，如 0.1.0-rc.6）</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          className="input grow"
          value={installVersion}
          onChange={(e) => setInstallVersion(e.currentTarget.value)}
          placeholder="例如 0.1.0-rc.6"
          disabled={!!busy}
        />
        <button className="btn primary" disabled={!!busy || !installVersion.trim()} onClick={() => void install()}>
          {busy === `install-${installVersion.trim()}` ? "安装中…" : "安装"}
        </button>
      </div>
      {remote && (
        <div className="hint" style={{ marginBottom: 10 }}>
          远程可用版本：{remote.slice(-12).join("、")}（共 {remote.length} 个，显示末尾 12 个）
        </div>
      )}

      {msg && <div className="error-banner" style={{ margin: "0 0 10px" }}>{msg}</div>}

      <div className="list" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 4 }}>
        {list === null && <div className="empty-state">加载中…</div>}
        {list !== null && list.length === 0 && <div className="empty-state">尚无受管运行时；可安装 {REPO_VERSION} 或其它精确版本</div>}
        {list?.map((r) => (
          <div className="list-item" key={r.version} style={{ flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="title">
                {r.version}
                {r.active && <span className="badge green" style={{ marginLeft: 8 }}>已启用</span>}
              </div>
              <div className="sub" style={{ fontSize: 11, wordBreak: "break-all" }}>
                {r.integrity ? `integrity: ${r.integrity.slice(0, 32)}…` : "无完整性记录"}
                {r.installed_at ? ` · 安装于 ${new Date(r.installed_at).toLocaleString("zh-CN", { hour12: false })}` : ""}
              </div>
              {verifyMap[r.version] && (
                <div className={`sub ${verifyMap[r.version]?.ok ? "" : "toolcall-err"}`} style={{ fontSize: 11 }}>
                  复验：{verifyMap[r.version]?.ok ? "通过" : "未通过"} · {verifyMap[r.version]?.detail}
                </div>
              )}
            </div>
            <div className="actions">
              <button className="btn sm" disabled={!!busy || running || r.active} onClick={() => void setActive(r.version)}>
                {busy === `active-${r.version}` ? "启用中…" : "设为启用"}
              </button>
              <button className="btn sm" disabled={!!busy} onClick={() => void verify(r.version)}>
                {busy === `verify-${r.version}` ? "复验中…" : "复验"}
              </button>
              <button className="btn sm" disabled={!!busy} onClick={() => setConfirmRemove(r)}>移除</button>
              <button className="btn sm" disabled={!!busy} onClick={() => void rollback(r.version)}>回滚</button>
            </div>
          </div>
        ))}
        {list !== null && list.length > 0 && (
          <div className="list-item">
            <div style={{ flex: 1 }}>
              <div className="title">仓库 bundled（{REPO_VERSION}）</div>
              <div className="sub">未启用任何受管版本时使用此运行时</div>
            </div>
            <div className="actions">
              <button className="btn sm" disabled={!!busy || running || (list.length > 0 && list.every((r) => !r.active))} onClick={() => void setActive(null)}>
                恢复默认
              </button>
            </div>
          </div>
        )}
      </div>

      {confirmRemove && (
        <div className="modal-mask" onClick={() => setConfirmRemove(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h4>移除运行时 {confirmRemove.version}？</h4>
            <div className="hint">
              移除是可逆操作：目录会移动到备份（.trash-…），可随时回滚。若该版本为当前启用版本，启用状态会被清除并恢复仓库 bundled。
            </div>
            <div className="modal-row">
              <button className="btn" onClick={() => setConfirmRemove(null)}>取消</button>
              <button className="btn danger" onClick={() => void remove(confirmRemove.version)}>确认移除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
