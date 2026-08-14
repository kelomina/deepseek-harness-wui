import { dsh } from "../lib/tauri";
import { appStore, useAppState } from "../lib/dsh/store";
import { Badge, Card } from "../components/ui";
import { LogPanel } from "../components/LogPanel";

const STATE_LABEL: Record<string, { text: string; tone: "ok" | "err" | "warn" | "brand" }> = {
  running: { text: "运行中", tone: "ok" },
  starting: { text: "启动中", tone: "warn" },
  stopped: { text: "已停止", tone: "brand" },
  error: { text: "错误", tone: "err" },
};

export function StatusPage() {
  const { status, host, connected } = useAppState();
  const running = status?.state === "running";
  const label = STATE_LABEL[status?.state ?? "stopped"] ?? STATE_LABEL.stopped;

  return (
    <div>
      <Card title="dsh 服务状态" extra={<Badge tone={label.tone}>{label.text}</Badge>}>
        <dl className="kv">
          <dt>状态消息</dt><dd>{status?.message ?? "-"}</dd>
          <dt>PID</dt><dd>{status?.pid ?? "-"}</dd>
          <dt>服务端口</dt><dd>{status?.port ?? "-"}</dd>
          <dt>代理端口</dt><dd>{status?.proxy_port ?? "-"}</dd>
          <dt>运行时长</dt><dd>{status?.uptime_secs != null ? `${Math.floor(status.uptime_secs / 60)}分${status.uptime_secs % 60}秒` : "-"}</dd>
          <dt>自动启动</dt><dd>{status?.auto_start ? "是" : "否"}</dd>
          <dt>协议连接</dt><dd>{connected ? "已连接" : "未连接"}</dd>
        </dl>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn primary" disabled={running} onClick={() => void dsh.start()}>
            启动 dsh
          </button>
          <button className="btn danger" disabled={!running} onClick={() => void dsh.stop()}>
            停止 dsh
          </button>
        </div>
      </Card>

      <Card title="宿主信息">
        {host ? (
          <dl className="kv">
            <dt>版本</dt><dd>{host.version}</dd>
            <dt>工作目录</dt><dd>{host.cwd}</dd>
            <dt>默认 Provider</dt><dd>{host.provider ?? "-"}</dd>
            <dt>默认模型</dt><dd>{host.model ?? "-"}</dd>
            <dt>附加会话数</dt><dd>{host.attachedSessions}</dd>
          </dl>
        ) : (
          <div className="muted">{running ? "连接中…" : "dsh 未运行"}</div>
        )}
      </Card>

      <Card
        title="dsh 日志"
        extra={
          <button className="btn sm" onClick={() => void (async () => {
            const logs = await dsh.getLogs(200);
            appStore.set({ logs });
          })()}>
            刷新
          </button>
        }
      >
        <LogPanel />
      </Card>
    </div>
  );
}

