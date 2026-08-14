import { useCallback, useEffect, useState } from "react";
import { dsh, type DshConfig, type ExecMode } from "../lib/tauri";
import { appStore, useAppState } from "../lib/dsh/store";
import type { ConfigurableProviderView, CredentialView } from "@deepseek-ai/dsh-host-apiproxy/api";

const DEEPSEEK_API_KEY_REF = "DEEPSEEK_API_KEY";

export function SettingsPage() {
  const { config, status, connected } = useAppState();
  const [form, setForm] = useState<DshConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const running = status?.state !== "stopped";

  // 模型提供商
  const [providers, setProviders] = useState<ConfigurableProviderView[] | null>(null);
  const [credState, setCredState] = useState<Record<string, CredentialView> | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState("deepseek-official");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editKey, setEditKey] = useState("");
  const [editModel, setEditModel] = useState("");
  const [providerMsg, setProviderMsg] = useState<string | null>(null);

  const refreshProviders = useCallback(async () => {
    if (!connected) return;
    try {
      const ps = await appStore.listProviders();
      setProviders(ps);
      const cr = await appStore.describeCredentials([DEEPSEEK_API_KEY_REF]);
      setCredState(cr);
    } catch (e) {
      setProviderMsg(String(e));
    }
  }, [connected]);

  useEffect(() => {
    if (config && !form) setForm(config);
  }, [config, form]);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const saveProvider = async () => {
    setProviderMsg(null);
    try {
      const ref = editType === "deepseek-official" ? DEEPSEEK_API_KEY_REF : editName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_") + "_API_KEY";
      if (editKey.trim()) {
        await appStore.setCredential(ref, editKey.trim());
      }
      setEditKey("");
      setProviderMsg(`「${editName.trim() || editType}」的 API Key 已写入凭据层（${ref}）；provider 路由/默认模型由 dsh settings 管理（开发中，可在 dsh web 配置）。`);
      setFormOpen(false);
      await refreshProviders();
    } catch (e) {
      setProviderMsg(String(e));
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
    <section className="view active" id="view-settings">
      <div className="col col-settings">
        <div className="view-cap">设置 · API Key</div>

        <div className="card wide">
          <div className="card-head">
            <span className="card-title">模型提供商</span>
            <button className="btn primary" onClick={() => { setFormOpen(true); setEditName(""); setEditType("deepseek-official"); setEditBaseUrl(""); setEditModel(""); }}>
              ＋ 添加提供商
            </button>
          </div>

          {!connected && <div className="muted">dsh 未连接，无法查看或配置凭据</div>}
          {connected && providers === null && <div className="muted">加载中…</div>}
          {connected && (
            <div className="provider-list">
              {(providers ?? []).map((p) => (
                <div className="provider" key={p.provider}>
                  <b>{p.displayName}</b>
                  <span className="pid">{p.provider}{p.settingsNs ? ` · ${p.settingsNs}` : ""}</span>
                  <span className={`badge ${p.active ? "green" : "gray"}`}>{p.active ? "激活" : "未激活"}</span>
                  <span className="p-act">
                    <span className="link" onClick={() => { setFormOpen(true); setEditName(p.displayName); setEditType(p.provider); }}>编辑</span>
                    <span className="link danger" title="由 dsh settings 管理（开发中）">删除</span>
                  </span>
                </div>
              ))}
              {providers && providers.length === 0 && <div className="muted">未发现提供商</div>}
            </div>
          )}

          {formOpen && (
            <div className="p-form" id="provider-form">
              <div className="card-head" style={{ marginBottom: 4 }}>
                <span className="card-title">编辑提供商</span>
                <span className="sub">路由/默认模型字段由 dsh settings 管理（开发中）；本表单当前保存 API Key 到凭据层</span>
              </div>
              <div className="two">
                <div>
                  <div className="f-label">名称</div>
                  <input type="text" value={editName} onChange={(e) => setEditName(e.currentTarget.value)} placeholder="如 DeepSeek" />
                </div>
                <div>
                  <div className="f-label">提供商类型</div>
                  <select value={editType} onChange={(e) => setEditType(e.currentTarget.value)}>
                    <option value="deepseek-official">deepseek-official</option>
                    <option value="openai-compatible">openai-compatible</option>
                    <option value="anthropic-compatible">anthropic-compatible</option>
                    <option value="custom">custom</option>
                  </select>
                </div>
              </div>
              <div className="f-label">Base URL（官方类型可留空）</div>
              <input type="text" value={editBaseUrl} onChange={(e) => setEditBaseUrl(e.currentTarget.value)} placeholder="https://api.deepseek.com" />
              <div className="f-label">API Key（凭据引用）</div>
              <div className="row">
                <input className="grow" type="password" value={editKey} onChange={(e) => setEditKey(e.currentTarget.value)} placeholder="已配置（输入新值可覆盖）" autoComplete="off" />
                <button className="btn primary" onClick={() => void saveProvider()}>保存</button>
                <button className="btn danger-o" onClick={() => { void appStore.unsetCredential(editType === "deepseek-official" ? DEEPSEEK_API_KEY_REF : (editName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_") + "_API_KEY")); }}>清除</button>
              </div>
              <div className="f-label">默认模型</div>
              <input type="text" value={editModel} onChange={(e) => setEditModel(e.currentTarget.value)} placeholder="deepseek-v4-flash-0731" />
              <div className="actions">
                <button className="btn primary" onClick={() => void saveProvider()}>保存提供商</button>
                <button className="btn" onClick={() => setFormOpen(false)}>取消</button>
              </div>
              <div className="hint">状态：<span className={`badge ${deepseek?.configured ? "green" : "gray"}`}>{deepseek?.configured ? "已配置" : "未配置"}</span> · Key 仅写入 dsh 凭据层，应用不存储</div>
              {providerMsg && <div className="hint">{providerMsg}</div>}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">dsh 运行配置</span></div>
          {running && <div className="error-banner">请先停止 dsh 再修改配置</div>}
          <div className="f-label">执行方式</div>
          <select value={form?.exec_mode ?? "bundled"} disabled={running || !form} onChange={(e) => form && set("exec_mode", e.currentTarget.value as ExecMode)}>
            <option value="bundled">Bundled（仓库 runtime/ 固定版本，推荐）</option>
            <option value="npx">npx（每次按固定版本拉取）</option>
            <option value="path">自定义路径</option>
          </select>
          {form?.exec_mode === "path" && (
            <>
              <div className="f-label">dsh 可执行文件路径</div>
              <input type="text" value={form.exec_path ?? ""} disabled={running} onChange={(e) => set("exec_path", e.currentTarget.value || null)} placeholder="例如 C:\tools\dsh\lib\bin.js" />
            </>
          )}
          <div className="f-label">Web 端口</div>
          <input type="text" value={form?.port ?? 3080} disabled={running} onChange={(e) => set("port", Number(e.currentTarget.value) || 0)} />
          <div className="f-label">DSH_HOME</div>
          <input type="text" value={form?.dsh_home ?? ""} disabled={running} onChange={(e) => set("dsh_home", e.currentTarget.value || null)} placeholder="留空使用系统默认" />
          <div className="f-label">
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={form?.auto_start ?? false} disabled={!form} onChange={(e) => set("auto_start", e.currentTarget.checked)} /> 应用启动时自动启动 dsh
            </label>
          </div>
          {saved && <div className="hint">{saved}</div>}
          <div className="actions">
            <button className="btn primary" disabled={running || saving || !form} onClick={() => void save()}>{saving ? "保存中…" : "保存配置"}</button>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">运行时硬限制（只读）</span></div>
          {form && (
            <>
              <div className="kv"><span className="k">启动超时</span><span className="v">{form.startup_timeout_secs} 秒</span></div>
              <div className="kv"><span className="k">健康检查间隔</span><span className="v">{form.health_interval_secs} 秒</span></div>
              <div className="kv"><span className="k">重启上限</span><span className="v">{form.max_restarts} 次 / {form.restart_window_secs} 秒</span></div>
              <div className="kv"><span className="k">日志上限</span><span className="v">{form.log_max_lines} 行（内存环形缓冲）</span></div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
