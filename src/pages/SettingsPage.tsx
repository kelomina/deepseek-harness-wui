import { useCallback, useEffect, useState } from "react";
import { dsh, type DshConfig, type ExecMode } from "../lib/tauri";
import { appStore, useAppState } from "../lib/dsh/store";
import { Badge, Card } from "../components/ui";
import type { ConfigurableProviderView, CredentialView } from "@deepseek-ai/dsh-host-apiproxy/api";

const DEEPSEEK_API_KEY_REF = "DEEPSEEK_API_KEY";

export function SettingsPage() {
  const { config, status, connected } = useAppState();
  const [form, setForm] = useState<DshConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const running = status?.state !== "stopped";

  // API Key state
  const [providers, setProviders] = useState<ConfigurableProviderView[] | null>(null);
  const [credState, setCredState] = useState<Record<string, CredentialView> | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);

  const refreshCredentials = useCallback(async () => {
    if (!connected) return;
    try {
      const ps = await appStore.listProviders();
      setProviders(ps);
      const cr = await appStore.describeCredentials([DEEPSEEK_API_KEY_REF]);
      setCredState(cr);
    } catch (e) {
      setKeyMsg(String(e));
    }
  }, [connected]);

  useEffect(() => {
    if (config && !form) setForm(config);
  }, [config, form]);

  useEffect(() => {
    void refreshCredentials();
  }, [refreshCredentials]);

  const saveKey = async () => {
    const value = keyDraft.trim();
    if (!value) {
      setKeyMsg("请输入 API Key");
      return;
    }
    if (/[\s\u0000-\u001f]/.test(value)) {
      setKeyMsg("API Key 不能包含空白或控制字符");
      return;
    }
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      await appStore.setCredential(DEEPSEEK_API_KEY_REF, value);
      setKeyDraft("");
      setKeyMsg("已保存（仅写入 dsh 凭据层，本应用不存储）");
      await refreshCredentials();
    } catch (e) {
      setKeyMsg(String(e));
    } finally {
      setKeyBusy(false);
    }
  };

  const clearKey = async () => {
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      await appStore.unsetCredential(DEEPSEEK_API_KEY_REF);
      setKeyMsg("已清除");
      await refreshCredentials();
    } catch (e) {
      setKeyMsg(String(e));
    } finally {
      setKeyBusy(false);
    }
  };

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

  const deepseek = credState?.[DEEPSEEK_API_KEY_REF];

  return (
    <div style={{ maxWidth: 720 }}>
      <Card title="模型与 API Key">
        {!connected && <div className="muted">dsh 未连接，无法查看或配置凭据</div>}
        {connected && (
          <>
            <div className="field">
              <label>模型提供商</label>
              {providers === null ? (
                <div className="muted">加载中…</div>
              ) : (
                <ul className="list" style={{ border: "1px solid var(--stroke-2)", borderRadius: 6 }}>
                  {providers.map((p) => (
                    <li key={p.provider} className="list-item" style={{ cursor: "default" }}>
                      <span className="title">{p.displayName}</span>
                      <span className="sub">{p.provider}</span>
                      {p.active ? <Badge tone="ok">激活</Badge> : <Badge>未激活</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="field">
              <label>DeepSeek API Key（凭据引用 {DEEPSEEK_API_KEY_REF}）</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="input"
                  type="password"
                  value={keyDraft}
                  disabled={!connected || keyBusy}
                  placeholder={deepseek?.configured ? "已配置（输入新值可覆盖）" : "sk-…"}
                  onChange={(e) => setKeyDraft(e.currentTarget.value)}
                  autoComplete="off"
                />
                <button className="btn primary" disabled={!connected || keyBusy || !keyDraft.trim()} onClick={() => void saveKey()}>
                  保存
                </button>
                <button className="btn danger" disabled={!connected || keyBusy || !deepseek?.configured} onClick={() => void clearKey()}>
                  清除
                </button>
              </div>
              <div className="hint">
                状态：
                {deepseek?.configured ? (
                  <Badge tone="ok">已配置（来源：{deepseek.source ?? "writable"}）</Badge>
                ) : (
                  <Badge>未配置</Badge>
                )}
                {deepseek && !deepseek.writable && "（当前不可写：环境变量等只读层正在覆盖）"}
              </div>
              <div className="hint">
                Key 仅写入 dsh 凭据层（$DSH_HOME/.credentials.yaml），经本应用代理单向传输，应用本身不存储、不回显。
              </div>
              {keyMsg && <div className="hint" style={{ color: "var(--success)" }}>{keyMsg}</div>}
            </div>
          </>
        )}
      </Card>

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
            value={form?.exec_mode}
            disabled={running || !form}
            onChange={(e) => form && set("exec_mode", e.currentTarget.value as ExecMode)}
          >
            <option value="bundled">Bundled（仓库 runtime/ 固定版本，推荐）</option>
            <option value="npx">npx（每次按固定版本拉取）</option>
            <option value="path">自定义路径</option>
          </select>
        </div>
        {form?.exec_mode === "path" && (
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
            value={form?.port ?? 0}
            disabled={running}
            onChange={(e) => set("port", Number(e.currentTarget.value) || 0)}
          />
          <div className="hint">dsh web 监听端口，默认 3080</div>
        </div>
        <div className="field">
          <label>DSH_HOME</label>
          <input
            className="input"
            value={form?.dsh_home ?? ""}
            disabled={running}
            onChange={(e) => set("dsh_home", e.currentTarget.value || null)}
            placeholder="留空使用系统默认（%USERPROFILE%\.dsh 等）"
          />
        </div>
        <div className="field">
          <label>工作目录（dsh 进程 cwd）</label>
          <input
            className="input"
            value={form?.workspace_dir ?? ""}
            disabled={running}
            onChange={(e) => set("workspace_dir", e.currentTarget.value || null)}
            placeholder="留空使用用户主目录"
          />
        </div>
        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={form?.auto_start ?? false}
              onChange={(e) => set("auto_start", e.currentTarget.checked)}
            />{" "}
            应用启动时自动启动 dsh
          </label>
        </div>
        {saved && <div className="badge ok" style={{ marginBottom: 8 }}>{saved}</div>}
        <div>
          <button className="btn primary" disabled={running || saving || !form} onClick={() => void save()}>
            {saving ? "保存中…" : "保存配置"}
          </button>
        </div>
      </Card>

      <Card title="运行时硬限制（只读）">
        {form && (
          <dl className="kv">
            <dt>启动超时</dt><dd>{form.startup_timeout_secs} 秒</dd>
            <dt>健康检查间隔</dt><dd>{form.health_interval_secs} 秒</dd>
            <dt>重启上限</dt><dd>{form.max_restarts} 次 / {form.restart_window_secs} 秒</dd>
            <dt>日志上限</dt><dd>{form.log_max_lines} 行（内存环形缓冲）</dd>
          </dl>
        )}
      </Card>
    </div>
  );
}
