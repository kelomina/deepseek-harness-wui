import { useCallback, useEffect, useState } from "react";
import { dsh, type DshConfig, type ExecMode } from "../lib/tauri";
import { appStore, useAppState } from "../lib/dsh/store";
import type { ConfigurableProviderView, SettingsPathOpView } from "@deepseek-ai/dsh-host-apiproxy/api";

type ModelRow = { id: string; name: string; context: string };

const emptyModelRow = (): ModelRow => ({ id: "", name: "", context: "" });

interface ProviderEdit {
  ns: "llm-deepseek" | "llm-pi-ai";
  routeKey: string;
  displayName: string;
  api: string;
  apiKeyEnv: string;
  baseURL: string;
  models: ModelRow[];
  keyDraft: string;
}

function buildModels(edit: ProviderEdit): Array<{ id: string; name: string; contextWindow?: number }> {
  const out: Array<{ id: string; name: string; contextWindow?: number }> = [];
  for (const row of edit.models) {
    const id = row.id.trim();
    if (!id) continue;
    const model: { id: string; name: string; contextWindow?: number } = { id, name: row.name.trim() || id };
    if (row.context.trim()) {
      const n = Number(row.context.trim());
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`模型「${id}」的上下文窗口必须是正整数`);
      }
      model.contextWindow = n;
    }
    out.push(model);
  }
  if (out.length === 0) {
    throw new Error("至少填写一个模型的「请求模型」ID");
  }
  return out;
}
export function SettingsPage() {
  const { config, status, connected, hiddenPresets } = useAppState();
  const [form, setForm] = useState<DshConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const running = status?.state !== "stopped";

  const [providers, setProviders] = useState<ConfigurableProviderView[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [edit, setEdit] = useState<ProviderEdit | null>(null);
  const [providerMsg, setProviderMsg] = useState<string | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [connLoading, setConnLoading] = useState(false);
  const [connResult, setConnResult] = useState<string | null>(null);

  const refreshProviders = useCallback(async () => {
    if (!connected) return;
    try {
      const ps = await appStore.listProviders();
      setProviders(ps);
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

  const openAdd = () => {
    setEdit({ ns: "llm-pi-ai", routeKey: "", displayName: "", api: "openai-completions", apiKeyEnv: "", baseURL: "", models: [emptyModelRow()], keyDraft: "" });
    setProviderMsg(null);
    setFormOpen(true);
  };

  const openEdit = async (p: ConfigurableProviderView) => {
    setProviderMsg(null);
    let apiKeyEnv = "";
    let baseURL = "";
    let models: ModelRow[] = [];
    try {
      const info = await appStore.getSettingsNamespace(p.settingsNs);
      const val = info?.value as { apiKeyEnv?: string; models?: unknown[]; providers?: Record<string, { apiKeyEnv?: string; baseURL?: string; models?: unknown[] }> } | undefined;
      if (p.settingsNs === "llm-deepseek") {
        apiKeyEnv = val?.apiKeyEnv ?? "DEEPSEEK_API_KEY";
      } else if (val?.providers) {
        const key = p.settingsPath[p.settingsPath.length - 1];
        const prof = key ? val.providers[key] : undefined;
        apiKeyEnv = prof?.apiKeyEnv ?? "";
        baseURL = prof?.baseURL ?? "";
      }
      const list = (val?.models ?? (val?.providers ? Object.values(val.providers).flatMap((x) => x.models ?? []) : [])) as Array<{ id?: string; name?: string; contextWindow?: number }>;
      models = list.map((m) => ({ id: m.id ?? "", name: m.name ?? "", context: m.contextWindow != null ? String(m.contextWindow) : "" }));
    } catch (e) {
      setProviderMsg(String(e));
    }
    setEdit({
      ns: (p.settingsNs === "llm-deepseek" ? "llm-deepseek" : "llm-pi-ai") as ProviderEdit["ns"],
      routeKey: p.provider,
      displayName: p.displayName,
      api: "openai-completions",
      apiKeyEnv,
      baseURL,
      models: models.length ? models : [emptyModelRow()],
      keyDraft: "",
    });
    setFormOpen(true);
  };

  const testConnection = async () => {
    if (!edit) return;
    setConnLoading(true);
    setConnResult(null);
    try {
      const models = await appStore.discoverModels({
        settingsNs: edit.ns,
        baseURL: edit.baseURL.trim() || undefined,
        api: edit.api,
        apiKey: edit.keyDraft.trim() || undefined,
      });
      setConnResult(models.length
        ? `连接成功，端点广告 ${models.length} 个模型：${models.slice(0, 6).map((m) => m.id).join(", ")}${models.length > 6 ? "…" : ""}`
        : "连接成功，但端点未返回模型列表");
    } catch (e) {
      setConnResult(`连接失败：${String(e).slice(0, 300)}`);
    } finally {
      setConnLoading(false);
    }
  };

  const saveProvider = async () => {
    if (!edit) return;
    const ops: SettingsPathOpView[] = [];
    const ref = edit.apiKeyEnv.trim() || "DEEPSEEK_API_KEY";
    if (edit.ns === "llm-deepseek") {
      if (edit.apiKeyEnv.trim() && edit.apiKeyEnv.trim() !== "DEEPSEEK_API_KEY") {
        ops.push({ op: "set", path: ["apiKeyEnv"], value: edit.apiKeyEnv.trim() });
      }
      if (edit.models.some((m) => m.id.trim())) {
        try {
          ops.push({ op: "set", path: ["models"], value: buildModels(edit) });
        } catch (e) {
          setProviderMsg(String(e));
          return;
        }
      }
    } else {
      const name = (edit.routeKey || edit.displayName).trim();
      if (!name) {
        setProviderMsg("需要提供商名称");
        return;
      }
      const base = ["providers", name];
      ops.push({ op: "set", path: [...base, "api"], value: edit.api });
      ops.push({ op: "set", path: [...base, "apiKeyEnv"], value: ref });
      if (edit.baseURL.trim()) ops.push({ op: "set", path: [...base, "baseURL"], value: edit.baseURL.trim() });
      if (edit.models.some((m) => m.id.trim())) {
        try {
          ops.push({ op: "set", path: [...base, "models"], value: buildModels(edit) });
        } catch (e) {
          setProviderMsg(String(e));
          return;
        }
      }
    }
    try {
      await appStore.mutateSettings(edit.ns, ops);
      if (edit.keyDraft.trim()) await appStore.setCredential(ref, edit.keyDraft.trim());
      setProviderMsg(`提供商「${edit.displayName || edit.routeKey}」已保存（凭据引用 ${ref}）`);
      setFormOpen(false);
      await refreshProviders();
    } catch (e) {
      setProviderMsg(String(e));
    }
  };

  const deleteProvider = async (p: ConfigurableProviderView) => {
    if (p.provider === "deepseek-official") {
      setProviderMsg("DeepSeek 官方为内置提供商，不可删除");
      return;
    }
    if (p.active) {
      // 已配置：移除配置（回退为未激活预设）
      const key = p.settingsPath[p.settingsPath.length - 1];
      if (!key) return;
      try {
        await appStore.mutateSettings(p.settingsNs, [{ op: "unset", path: ["providers", key] }]);
        setProviderMsg(`已移除提供商「${p.provider}」的配置（dsh 内置预设仍保留，可从列表隐藏）`);
      } catch (e) {
        setProviderMsg(String(e));
        return;
      }
    }
    // 预设（未配置）或已移除配置：从列表隐藏（dsh 内置预设无法删除）
    appStore.hidePreset(p.provider);
    await refreshProviders();
  };

  const providerRow = (p: ConfigurableProviderView, actionable: boolean) => (
    <div className="provider" key={p.provider}>
      <b>{p.displayName}</b>
      <span className="pid">{p.provider} · {p.settingsNs}{p.settingsPath.length ? `/${p.settingsPath.slice(-1)[0]}` : ""}</span>
      <span className={`badge ${p.active ? "green" : "gray"}`}>{p.active ? "激活" : "未激活"}</span>
      <span className="p-act">
        {!p.active && <span className="link" onClick={() => void openEdit(p)}>激活</span>}
        <span className="link" onClick={() => void openEdit(p)}>编辑</span>
        {p.provider === "deepseek-official" ? (
          <span className="link danger" style={{ opacity: 0.4, cursor: "not-allowed" }} title="内置提供商，不可删除">删除</span>
        ) : (
          <span className="link danger" onClick={() => void deleteProvider(p)}>{actionable ? "删除" : "隐藏"}</span>
        )}
      </span>
    </div>
  );

  const activeList = (providers ?? []).filter((p) => p.active || p.provider === "deepseek-official");
  const presetList = (providers ?? []).filter((p) => !p.active && p.settingsNs === "llm-pi-ai" && !hiddenPresets.includes(p.provider));
  const hiddenList = (providers ?? []).filter((p) => hiddenPresets.includes(p.provider));

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
    <section className="view active" id="view-settings">
      <div className="col col-settings">
        <div className="view-cap">设置 · API Key</div>

        <div className="card wide">
          <div className="card-head">
            <span className="card-title">模型提供商</span>
            <button className="btn primary" onClick={openAdd}>＋ 添加提供商</button>
          </div>

          {!connected && <div className="muted">dsh 未连接，无法查看或配置提供商</div>}
          {connected && providers === null && <div className="muted">加载中…</div>}
          {connected && (
            <div className="provider-list">
              <div className="f-label">已配置 / 激活</div>
              {activeList.map((p) => providerRow(p, true))}
              {activeList.length === 0 && <div className="muted">暂无已配置提供商</div>}

              <div className="f-label" style={{ marginTop: 14 }}>
                预设（未配置）{presetList.length > 0 && <span className="link" style={{ marginLeft: 8 }} onClick={() => setShowPresets((v) => !v)}>{showPresets ? "收起" : `展开 ${presetList.length} 个`}</span>}
              </div>
              {showPresets && presetList.map((p) => providerRow(p, false))}
              {showPresets && presetList.length === 0 && <div className="muted">没有未配置预设</div>}

              {hiddenList.length > 0 && (
                <div className="f-label" style={{ marginTop: 14 }}>已隐藏（dsh 内置预设，仅本地隐藏）
                  {hiddenList.map((p) => (
                    <span key={p.provider} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
                      <span style={{ color: "var(--text-2)" }}>{p.provider}</span>
                      <span className="link" onClick={() => appStore.unhidePreset(p.provider)}>恢复</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {providerMsg && <div className="hint" style={{ marginTop: 10 }}>{providerMsg}</div>}

          {formOpen && edit && (
            <div className="p-form" id="provider-form">
              <div className="card-head" style={{ marginBottom: 4 }}>
                <span className="card-title">{edit.routeKey && edit.ns === "llm-pi-ai" ? `编辑提供商 ${edit.routeKey}` : "添加提供商"}</span>
                <span className="sub">{edit.ns === "llm-deepseek" ? "DeepSeek 官方（llm-deepseek）" : "OpenAI 兼容路由（llm-pi-ai）"}</span>
              </div>

              {edit.ns === "llm-pi-ai" && (
                <div className="two">
                  <div>
                    <div className="f-label">名称（路由 key）</div>
                    <input type="text" value={edit.displayName} onChange={(e) => setEdit({ ...edit, displayName: e.currentTarget.value })} placeholder="如 moonshot" disabled={!!edit.routeKey} />
                  </div>
                  <div>
                    <div className="f-label">Wire 协议</div>
                    <select value={edit.api} onChange={(e) => setEdit({ ...edit, api: e.currentTarget.value })}>
                      <option value="openai-completions">openai-completions</option>
                      <option value="openai-responses">openai-responses</option>
                      <option value="anthropic-messages">anthropic-messages</option>
                    </select>
                  </div>
                </div>
              )}

              <div className="f-label">凭据引用（apiKeyEnv）</div>
              <input type="text" value={edit.apiKeyEnv} onChange={(e) => setEdit({ ...edit, apiKeyEnv: e.currentTarget.value })} placeholder={edit.ns === "llm-deepseek" ? "DEEPSEEK_API_KEY" : "如 MOONSHOT_API_KEY"} />

              {edit.ns === "llm-pi-ai" && (
                <>
                  <div className="f-label">Base URL</div>
                  <input type="text" value={edit.baseURL} onChange={(e) => setEdit({ ...edit, baseURL: e.currentTarget.value })} placeholder="https://api.moonshot.cn/v1" />
                  <div className="hint">OpenAI 兼容 API 根地址（通常以 /v1 结尾，如 https://api.moonshot.cn/v1）；不是官网首页。可先点「测试连接」验证。</div>
                </>
              )}

              <div className="f-label">API Key（写入凭据层，应用不存储）</div>
              <div className="row">
                <input className="grow" type="password" value={edit.keyDraft} onChange={(e) => setEdit({ ...edit, keyDraft: e.currentTarget.value })} placeholder="输入新值可覆盖；留空则保留已存值" autoComplete="off" />
              </div>

              <div className="f-label">模型列表（留空则不修改；默认一个模型，可添加多个）</div>
              {edit.models.map((m, idx) => (
                <div key={idx} style={{ border: "1px dashed var(--border)", borderRadius: 8, padding: 10, marginBottom: 8 }}>
                  <div className="two">
                    <div>
                      <div className="f-label" style={{ marginTop: 0 }}>请求模型（API 模型 ID）</div>
                      <input type="text" value={m.id} onChange={(e) => {
                        const next = [...edit.models];
                        next[idx] = { ...m, id: e.currentTarget.value };
                        setEdit({ ...edit, models: next });
                      }} placeholder="如 moonshot-v1-8k" />
                    </div>
                    <div>
                      <div className="f-label" style={{ marginTop: 0 }}>显示模型（显示名）</div>
                      <input type="text" value={m.name} onChange={(e) => {
                        const next = [...edit.models];
                        next[idx] = { ...m, name: e.currentTarget.value };
                        setEdit({ ...edit, models: next });
                      }} placeholder="留空则同请求模型" />
                    </div>
                  </div>
                  <div className="row" style={{ marginTop: 6, alignItems: "flex-end" }}>
                    <div style={{ flex: 1 }}>
                      <div className="f-label" style={{ marginTop: 0 }}>模型上下文窗口（tokens）</div>
                      <input type="text" value={m.context} onChange={(e) => {
                        const next = [...edit.models];
                        next[idx] = { ...m, context: e.currentTarget.value };
                        setEdit({ ...edit, models: next });
                      }} placeholder="如 8192" />
                    </div>
                    <button className="btn danger-o" disabled={edit.models.length <= 1} onClick={() => setEdit({ ...edit, models: edit.models.filter((_, i) => i !== idx) })}>删除模型</button>
                  </div>
                </div>
              ))}
              <button className="btn sm" onClick={() => setEdit({ ...edit, models: [...edit.models, emptyModelRow()] })}>＋ 添加模型</button>

              <div className="actions">
                <button className="btn primary" onClick={() => void saveProvider()}>保存提供商</button>
                <button className="btn" disabled={connLoading} onClick={() => void testConnection()}>{connLoading ? "测试中…" : "测试连接"}</button>
                <button className="btn" onClick={() => setFormOpen(false)}>取消</button>
              </div>
              {connResult && <div className="hint" style={{ color: connResult.startsWith("连接失败") ? "var(--red)" : "var(--text-3)" }}>{connResult}</div>}
              <div className="hint">保存即写入 dsh settings（live 生效）；添加的路由会立即激活。DeepSeek 官方无需 baseURL；模型选择在新建会话时进行。</div>
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




