import { dsh } from "../lib/tauri";
import { appStore, useAppState } from "../lib/dsh/store";

export function StatusPage() {
  const { status, host, connected, logs } = useAppState();
  const running = status?.state === "running";

  const refreshLogs = async () => {
    try {
      const list = await dsh.getLogs(200);
      appStore.set({ logs: list });
    } catch (e) {
      appStore.set({ error: String(e) });
    }
  };

  return (
    <section className="view active" id="view-status">
      <div className="col col-status">
        <div className="view-cap">连接状态</div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">dsh 服务状态</span>
            <span className={`badge ${running ? "green" : status?.state === "error" ? "orange" : "gray"}`}>
              {running ? "运行中" : status?.state === "error" ? "错误" : "已停止"}
            </span>
          </div>
          <div className="kv"><span className="k">状态消息</span><span className="v">{status?.message ?? "-"}</span></div>
          <div className="kv"><span className="k">PID</span><span className="v">{status?.pid ?? "-"}</span></div>
          <div className="kv"><span className="k">服务端口</span><span className="v">{status?.port ?? "-"}</span></div>
          <div className="kv"><span className="k">代理端口</span><span className="v">{status?.proxy_port ?? "-"}</span></div>
          <div className="kv"><span className="k">运行时长</span><span className="v">{status?.uptime_secs != null ? `${Math.floor(status.uptime_secs / 60)}分${status.uptime_secs % 60}秒` : "-"}</span></div>
          <div className="kv"><span className="k">协议连接</span><span className="v">{connected ? "已连接" : "未连接"}</span></div>
          <div className="kv"><span className="k">dsh 代理</span><span className="v">{status?.proxy_used ?? "未启用（直连）"}</span></div>
          <div className="actions">
            <button className="btn primary" disabled={running} onClick={() => void dsh.start()}>启动 dsh</button>
            <button className="btn danger-o" disabled={!running} onClick={() => void dsh.stop()}>停止 dsh</button>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">宿主信息</span></div>
          <div className="kv"><span className="k">版本</span><span className="v">{host?.version ?? "-"}</span></div>
          <div className="kv"><span className="k">工作目录</span><span className="v">{host?.cwd ?? "-"}</span></div>
          <div className="kv"><span className="k">默认 Provider</span><span className="v">{host?.provider ?? "-"}</span></div>
          <div className="kv"><span className="k">默认模型</span><span className="v">{host?.model ?? "-"}</span></div>
          <div className="kv"><span className="k">附加会话数</span><span className="v">{host?.attachedSessions ?? "-"}</span></div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">dsh 日志</span><button className="btn sm" onClick={() => void refreshLogs()}>刷新</button></div>
          <div className="term">
            {logs.length === 0 ? "(暂无日志)" : logs.join("\n")}
          </div>
        </div>
      </div>
    </section>
  );
}

