import { useEffect, useState } from "react";
import { dsh, type DshConfig, type ExecMode } from "../lib/tauri";
import { appStore, useAppState } from "../lib/dsh/store";
import { Card } from "../components/ui";

export function SettingsPage() {
  const { config, status } = useAppState();
  const [form, setForm] = useState<DshConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const running = status?.state !== "stopped";

  useEffect(() => {
    if (config && !form) setForm(config);
  }, [config, form]);

  if (!form) return <div className="empty-state">加载配置中…</div>;

  const set = <K extends keyof DshConfig>(key: K, value: DshConfig[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setSaved(null);
    try {
      await dsh.setConfig(form);
      setSaved("配置已保存（下次启动 dsh 时生效）");
      const cfg = await dsh.getConfig();
      appStore.set({ config: cfg });
    } catch (e) {
      appStore.set({ error: String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <Card title="dsh 运行配置">
        {running && (
          <div className="error-banner" style={{ margin: 0, marginBottom: 12 }}>
            请先停止 dsh 再修改配置
          </div>
        )}
        <div className="field">
          <label>执行方式</label>
          <select
            className="select"
            value={form.exec_mode}
            disabled={running}
            onChange={(e) => set("exec_mode", e.currentTarget.value as ExecMode)}
          >
            <option value="bundled">Bundled（仓库 runtime/ 固定版本，推荐）</option>
            <option value="npx">npx（每次按固定版本拉取）</option>
            <option value="path">自定义路径</option>
          </select>
        </div>
        {form.exec_mode === "path" && (
          <div className="field">
            <label>dsh 可执行文件路径</label>
            <input
              className="input"
              value={form.exec_path ?? ""}
              disabled={running}
              onChange={(e) => set("exec_path", e.currentTarget.value || null)}
              placeholder="例如 C:\tools\dsh\lib\bin.js"
            />
          </div>
        )}
        <div className="field">
          <label>Web 端口</label>
          <input
            className="input"
            type="number"
            min={1}
            max={65535}
            value={form.port}
            disabled={running}
            onChange={(e) => set("port", Number(e.currentTarget.value) || 0)}
          />
          <div className="hint">dsh web 监听端口，默认 3080</div>
        </div>
        <div className="field">
          <label>DSH_HOME</label>
          <input
            className="input"
            value={form.dsh_home ?? ""}
            disabled={running}
            onChange={(e) => set("dsh_home", e.currentTarget.value || null)}
            placeholder="留空使用系统默认（%USERPROFILE%\.dsh 等）"
          />
        </div>
        <div className="field">
          <label>工作目录（dsh 进程 cwd）</label>
          <input
            className="input"
            value={form.workspace_dir ?? ""}
            disabled={running}
            onChange={(e) => set("workspace_dir", e.currentTarget.value || null)}
            placeholder="留空使用用户主目录"
          />
        </div>
        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={form.auto_start}
              onChange={(e) => set("auto_start", e.currentTarget.checked)}
            />{" "}
            应用启动时自动启动 dsh
          </label>
        </div>
        {saved && <div className="badge ok" style={{ marginBottom: 8 }}>{saved}</div>}
        <div>
          <button className="btn primary" disabled={running || saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存配置"}
          </button>
        </div>
      </Card>

      <Card title="运行时硬限制（只读）">
        <dl className="kv">
          <dt>启动超时</dt><dd>{form.startup_timeout_secs} 秒</dd>
          <dt>健康检查间隔</dt><dd>{form.health_interval_secs} 秒</dd>
          <dt>重启上限</dt><dd>{form.max_restarts} 次 / {form.restart_window_secs} 秒</dd>
          <dt>日志上限</dt><dd>{form.log_max_lines} 行（内存环形缓冲）</dd>
        </dl>
      </Card>
    </div>
  );
}
