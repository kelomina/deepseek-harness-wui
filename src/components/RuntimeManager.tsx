import { useCallback, useEffect, useState } from "react";
import { dsh, runtime, type RuntimeView, type VerifyReport } from "../lib/tauri";
import { appStore } from "../lib/dsh/store";
import { logger } from "../lib/logger";
import { withLoading, isDedupError, isCancelError } from "../lib/loading";

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
      logger.error("runtime", `获取已安装运行时列表失败: ${String(e)}`, e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fetchRemote = async () => {
    setBusy("remote");
    setMsg(null);
    logger.info("runtime", "正在获取远程可用版本列表...");
    try {
      const versions = await withLoading("runtime_remote_versions_cmd", "正在获取远程版本…", () => runtime.remoteVersions(), {
        stage: "正在连接源…",
      });
      setRemote(versions);
      logger.info("runtime", `成功获取远程版本列表，共 ${versions.length} 个版本: ${versions.slice(-5).join(", ")}等`);
    } catch (e) {
      if (isDedupError(e) || isCancelError(e)) {
        setBusy(null);
        return;
      }
      const err = `获取远程版本失败: ${String(e instanceof Error ? e.message : e)}`;
      setMsg(err);
      logger.error("runtime", err, e);
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    const v = installVersion.trim();
    if (!v) return;
    setBusy(`install-${v}`);
    setMsg(null);
    logger.info("runtime", `开始下载并安装受管运行时 ${v}...`);
    try {
      const view = await withLoading(`runtime_install_cmd`, `正在安装 dsh 运行时 ${v}`, () => runtime.install(v), {
        stage: "正在下载…",
        args: { version: v },
      });
      setMsg(`已安装 ${view.version}（integrity 校验通过）`);
      logger.info("runtime", `已安装 ${view.version}（integrity 校验通过）`);
      setInstallVersion("");
      await refresh();
    } catch (e) {
      if (isDedupError(e) || isCancelError(e)) {
        setBusy(null);
        return;
      }
      setMsg(String(e instanceof Error ? e.message : e));
      logger.error("runtime", `安装 ${v} 失败: ${String(e)}`, e);
    } finally {
      setBusy(null);
    }
  };

  const verify = async (version: string) => {
    setBusy(`verify-${version}`);
    setMsg(null);
    logger.info("runtime", `正在复验版本 ${version} 的完整性...`);
    try {
      const report = await withLoading(`runtime_verify_cmd`, `正在复验运行时 ${version}…`, () => runtime.verify(version), {
        stage: "正在检测…",
        args: { version },
      });
      setVerifyMap((m) => ({ ...m, [version]: report }));
      if (report.ok) {
        logger.info("runtime", `版本 ${version} 复验通过: ${report.detail}`);
      } else {
        logger.warn("runtime", `版本 ${version} 复验未通过: ${report.detail}`, report);
      }
    } catch (e) {
      if (isDedupError(e) || isCancelError(e)) {
        setBusy(null);
        return;
      }
      setMsg(String(e instanceof Error ? e.message : e));
      logger.error("runtime", `复验版本 ${version} 失败: ${String(e)}`, e);
    } finally {
      setBusy(null);
    }
  };

  const setActive = async (version: string | null) => {
    setBusy(`active-${version ?? "none"}`);
    setMsg(null);
    logger.info("runtime", `切换激活受管版本为: ${version ?? "仓库 bundled"}`);
    try {
      await withLoading("runtime_set_active_cmd", "正在切换运行时…", () => runtime.setActive(version), {
        stage: "正在准备…",
        args: { version },
      });
      await refresh();
      const cfg = await dsh.getConfig();
      appStore.set({ config: cfg });
      const m = version ? `已启用受管运行时 ${version}（下次启动 dsh 生效）` : "已恢复仓库 bundled 运行时（下次启动 dsh 生效）";
      setMsg(m);
      logger.info("runtime", m);
    } catch (e) {
      if (isDedupError(e) || isCancelError(e)) {
        setBusy(null);
        return;
      }
      setMsg(String(e instanceof Error ? e.message : e));
      logger.error("runtime", `切换运行时失败: ${String(e)}`, e);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (version: string) => {
    setBusy(`remove-${version}`);
    setMsg(null);
    logger.info("runtime", `正在移除运行时 ${version}...`);
    try {
      const backup = await withLoading(`runtime_remove_cmd`, `正在移除运行时 ${version}…`, () => runtime.remove(version), {
        stage: "正在准备…",
        args: { version },
      });
      const m = `已移除 ${version}（可回滚，备份位于 ${backup}）`;
      setMsg(m);
      logger.info("runtime", m);
      setConfirmRemove(null);
      await refresh();
    } catch (e) {
      if (isDedupError(e) || isCancelError(e)) {
        setBusy(null);
        return;
      }
      setMsg(String(e instanceof Error ? e.message : e));
      logger.error("runtime", `移除 ${version} 失败: ${String(e)}`, e);
    } finally {
      setBusy(null);
    }
  };

  const rollback = async (version: string) => {
    setBusy(`rollback-${version}`);
    setMsg(null);
    logger.info("runtime", `正在回滚运行时 ${version}...`);
    try {
      await withLoading(`runtime_rollback_cmd`, `正在回滚运行时 ${version}…`, () => runtime.rollback(version), {
        stage: "正在准备…",
        args: { version },
      });
      const m = `已回滚 ${version}`;
      setMsg(m);
      logger.info("runtime", m);
      await refresh();
    } catch (e) {
      if (isDedupError(e) || isCancelError(e)) {
        setBusy(null);
        return;
      }
      setMsg(String(e instanceof Error ? e.message : e));
      logger.error("runtime", `回滚 ${version} 失败: ${String(e)}`, e);
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

      {msg && <div className="error-banner" title={msg} style={{ margin: "0 0 10px", userSelect: "text" }}>{msg}</div>}

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
