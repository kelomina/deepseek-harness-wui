import { useState } from "react";
import { prereq, runtime, type PrereqCheck, type NodeInstallReport } from "../lib/tauri";

/** 首启安装向导：Node.js 缺失 → 官方包下载校验 + 提权静默安装；dsh 运行时缺失 → 受管运行时安装。
 * 全部就绪后 onComplete（由 App 继续 appStore.init()）。 */
export function SetupWizard({ prereq: initial, onDone }: { prereq: PrereqCheck; onDone: () => void }) {
  const [check, setCheck] = useState<PrereqCheck>(initial);
  const [busy, setBusy] = useState<"node" | "dsh" | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const nodeOk = !!check.node_version;
  const dshOk = !!check.dsh_runtime_version || check.bundled_present;
  const done = nodeOk && dshOk;

  const refresh = async () => {
    try {
      setCheck(await prereq.check());
    } catch (e) {
      setError(String(e));
    }
  };

  const installNode = async () => {
    setBusy("node");
    setError(null);
    setLog([]);
    try {
      const r: NodeInstallReport = await prereq.installNode();
      setLog(r.steps);
      if (!r.ok) setError(r.error ?? "Node 安装失败");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const installDsh = async () => {
    setBusy("dsh");
    setError(null);
    try {
      // 与 wsl.rs / runtime.rs 口径一致的精确锁定版本
      await runtime.install("0.1.1-rc.2");
      await runtime.setActive("0.1.1-rc.2");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  return (
    <div className="modal-mask" style={{ zIndex: 400 }}>
      <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <h4>首次运行准备</h4>
        <div className="hint">
          运行 DeepSeek Harness 需要两个组件：Node.js（用于拉起 dsh 进程）与 dsh 运行时本体。
          缺失项可一键自动安装（需要网络；Node 安装会弹出系统授权窗口）。
        </div>

        <div className="provider-list" style={{ marginTop: 12 }}>
          {/* Node.js */}
          <div className="queue-item">
            <span className={`badge ${nodeOk ? "green" : "orange"}`}>{nodeOk ? "已就绪" : "未安装"}</span>
            <span className="queue-text">
              Node.js{check.node_version ? ` · ${check.node_version}` : "（≥ v22.19，官方 nodejs.org 源）"}
            </span>
            {!nodeOk && (
              <button className="btn sm primary" disabled={busy !== null} onClick={() => void installNode()}>
                {busy === "node" ? "安装中…" : "自动安装"}
              </button>
            )}
          </div>

          {/* dsh 运行时 */}
          <div className="queue-item">
            <span className={`badge ${dshOk ? "green" : "orange"}`}>{dshOk ? "已就绪" : "未安装"}</span>
            <span className="queue-text">
              dsh 运行时
              {check.dsh_runtime_version
                ? ` · ${check.dsh_runtime_version}`
                : check.bundled_present
                  ? " · 使用开发目录 bundled 版本"
                  : "（npm registry 源 · SHA512 校验 · 可回滚）"}
            </span>
            {!dshOk && (
              <button className="btn sm primary" disabled={busy !== null} onClick={() => void installDsh()}>
                {busy === "dsh" ? "安装中…" : "自动安装"}
              </button>
            )}
          </div>
        </div>

        {log.length > 0 && (
          <pre className="term" style={{ maxHeight: 180, overflow: "auto", marginTop: 10, fontSize: 11 }}>
            {log.join("\n")}
          </pre>
        )}
        {error && <div className="hint" style={{ color: "var(--red)", marginTop: 8 }}>{error}</div>}

        <div className="modal-row" style={{ marginTop: 14 }}>
          <button className="btn" disabled={busy !== null} onClick={() => void refresh()}>重新检测</button>
          <button className="btn primary" disabled={!done || busy !== null} onClick={onDone}>
            进入应用
          </button>
        </div>
      </div>
    </div>
  );
}
