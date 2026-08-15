import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { dsh, type DshConfig, type ExecMode } from "../lib/tauri";
import { appStore, useAppState } from "../lib/dsh/store";
import { RuntimeManager } from "../components/RuntimeManager";
import { DEFAULT_COT_RULES, loadCotConfig, saveCotConfig, type CotDetectConfig } from "../lib/dsh/cotDetect";
import { WslPanel } from "../components/WslPanel";
import type { AgentPresetEntry, ConfigurableProviderView, SettingsPathOpView } from "@deepseek-ai/dsh-host-apiproxy/api";

type PluginView = { id: string; name: string; enabled: boolean; builtin: boolean; conditional?: boolean };
type PluginTab = "all" | "on" | "off";

function presetInitial(p: { id: string; name?: string }): string {
  const n = (p.name ?? p.id).trim();
  return n ? n[0].toUpperCase() : "?";
}
function plugInitial(p: PluginView): string {
  const n = (p.name || p.id).trim();
  return n ? n[0].toUpperCase() : "?";
}

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
function CotSettings() {
  const [cfg, setCfg] = useState<CotDetectConfig>(() => loadCotConfig());
  const [rulesText, setRulesText] = useState(cfg.rules.join("\n"));
  const [msg, setMsg] = useState<string | null>(null);

  const save = () => {
    const rules = rulesText.split("\n").map((r) => r.trim()).filter(Boolean);
    const next: CotDetectConfig = { enabled: cfg.enabled, rules };
    saveCotConfig(next);
    setCfg(next);
    setMsg("已保存（仅本机 localStorage；默认规则保守，误报/漏报不可避免）");
  };

  return (
    <div className="card">
      <div className="card-head"><span className="card-title">DeepSeek-V4-Pro 思维链降智检测（启发式提示）</span></div>
      <div className="f-label">
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.currentTarget.checked })} /> 启用检测
        </label>
      </div>
      <div className="f-label">正则规则（每行一条；非法正则自动跳过）</div>
      <textarea
        className="input"
        style={{ minHeight: 120, fontFamily: "Consolas, monospace", fontSize: 12, whiteSpace: "pre", width: "100%" }}
        value={rulesText}
        onChange={(e) => setRulesText(e.currentTarget.value)}
        placeholder={DEFAULT_COT_RULES.join("\n")}
      />
      <div className="hint" style={{ marginTop: 8 }}>
        {`提示措辞：检测到当前思维链可能异常，存在被路由到低质量模型或生成质量下降的可能。该提示为启发式判断，不代表模型身份结论。\n模型可识别性（V4-Pro 出现在 llm.models / session.models.current）需按 docs/RISKS.md spike 结论；未确认前按假设处理。检测不阻断对话、不改变模型路由。`}
      </div>
      {msg && <div className="hint" style={{ color: "var(--green)" }}>{msg}</div>}
      <div className="actions">
        <button className="btn primary" onClick={save}>保存规则</button>
        <button className="btn" onClick={() => { setRulesText(DEFAULT_COT_RULES.join("\n")); setCfg({ enabled: cfg.enabled, rules: [...DEFAULT_COT_RULES] }); }}>恢复默认</button>
      </div>
    </div>
  );
}

export function SettingsPage({ onStartSession }: { onStartSession?: () => void }) {
  const { config, status, connected, hiddenPresets, agentPresets, agentPresetsMeta } = useAppState();
  const [form, setForm] = useState<DshConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [tab, setTab] = useState<"providers" | "agent" | "plugins" | "dsh" | "runtime" | "wsl" | "assist">("providers");
  const running = status?.state !== "stopped";

  // Agent 模式管理
  const [agentMsg, setAgentMsg] = useState<string | null>(null);
  const [copyTarget, setCopyTarget] = useState<AgentPresetEntry | null>(null);
  const [copyId, setCopyId] = useState("");
  const [copyName, setCopyName] = useState("");
  const [copyErr, setCopyErr] = useState<string | null>(null);
  const [viewTarget, setViewTarget] = useState<{ id: string; name: string; content: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AgentPresetEntry | null>(null);

  // 插件管理
  const [plugins, setPlugins] = useState<PluginView[] | null>(null);
  const [pluginTab, setPluginTab] = useState<PluginTab>("all");
  const [pluginMsg, setPluginMsg] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSpec, setImportSpec] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [pluginDelete, setPluginDelete] = useState<PluginView | null>(null);
  const [pluginBusyId, setPluginBusyId] = useState<string | null>(null);

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

  const refreshPlugins = useCallback(async () => {
    if (!connected) return;
    try {
      const list = await invoke<PluginView[]>("plugins_list_cmd");
      setPlugins(list);
    } catch (e) {
      setPluginMsg(String(e));
    }
  }, [connected]);

  useEffect(() => {
    if (connected) void appStore.loadAgentPresets();
  }, [connected]);

  useEffect(() => {
    void refreshPlugins();
  }, [refreshPlugins]);

  const openCopy = (p: AgentPresetEntry) => {
    setCopyTarget(p);
    setCopyId("");
    setCopyName("");
    setCopyErr(null);
  };

  const doCopy = async () => {
    if (!copyTarget) return;
    const id = copyId.trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      setCopyErr("标识符需以小写字母或数字开头，仅含小写字母/数字/连字符");
      return;
    }
    if ((agentPresets ?? []).some((p) => p.id === id)) {
      setCopyErr("该标识符已被占用，请换一个");
      return;
    }
    try {
      await appStore.copyAgentPreset(copyTarget.id, id, copyName);
      setAgentMsg(`已复制「${copyTarget.name ?? copyTarget.id}」→ ${id}`);
      setCopyTarget(null);
    } catch (e) {
      setCopyErr(String(e));
    }
  };

  const openView = async (p: AgentPresetEntry) => {
    const r = await appStore.readAgentPreset(p.id);
    if (r) setViewTarget({ id: p.id, name: r.name ?? p.id, content: r.content });
  };

  const setDefault = async (p: AgentPresetEntry) => {
    await appStore.setDefaultAgentPreset(p.id);
    setAgentMsg(`已设为默认：${p.name ?? p.id}`);
  };

  const startCreator = async () => {
    const id = await appStore.createSessionWithAgentPreset("cordis");
    if (id) onStartSession?.();
  };

  const togglePlugin = async (p: PluginView) => {
    setPluginBusyId(p.id);
    setPluginMsg(null);
    try {
      const r = await invoke<string>("plugins_set_enabled_cmd", { id: p.id, enabled: !p.enabled });
      setPluginMsg(r);
      await refreshPlugins();
    } catch (e) {
      setPluginMsg(String(e));
    } finally {
      setPluginBusyId(null);
    }
  };

  const doImport = async () => {
    if (!importSpec.trim()) return;
    setImportBusy(true);
    setPluginMsg(null);
    try {
      const r = await invoke<string>("plugins_import_cmd", { spec: importSpec.trim() });
      setPluginMsg(r);
      setImportOpen(false);
      setImportSpec("");
      await refreshPlugins();
    } catch (e) {
      setPluginMsg(String(e));
    } finally {
      setImportBusy(false);
    }
  };

  const deletePlugin = async (p: PluginView) => {
    try {
      const r = await invoke<string>("plugins_remove_cmd", { name: p.name || p.id });
      setPluginMsg(r);
      setPluginDelete(null);
      await refreshPlugins();
    } catch (e) {
      setPluginMsg(String(e));
      setPluginDelete(null);
    }
  };

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
        <div className="settings-tabs">
          <button className={`stab${tab === "providers" ? " on" : ""}`} onClick={() => setTab("providers")}>模型提供商</button>
          <button className={`stab${tab === "agent" ? " on" : ""}`} onClick={() => setTab("agent")}>Agent 模式</button>
          <button className={`stab${tab === "plugins" ? " on" : ""}`} onClick={() => setTab("plugins")}>插件</button>
          <button className={`stab${tab === "dsh" ? " on" : ""}`} onClick={() => setTab("dsh")}>DSH 运行配置</button>
          <button className={`stab${tab === "runtime" ? " on" : ""}`} onClick={() => setTab("runtime")}>DSH 运行时</button>
          <button className={`stab${tab === "wsl" ? " on" : ""}`} onClick={() => setTab("wsl")}>WSL 连接</button>
          <button className={`stab${tab === "assist" ? " on" : ""}`} onClick={() => setTab("assist")}>智能辅助</button>
        </div>

        {tab === "providers" && (
          <>
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
          </>
        )}

        {tab === "agent" && (
          <>
        <div className="card">
          <div className="card-head">
            <span className="card-title">Agent 模式</span>
            {agentMsg && <span className="hint" style={{ color: "var(--text-2)" }}>{agentMsg}</span>}
          </div>
          {!connected && <div className="muted">dsh 未连接，无法查看 Agent 模式</div>}
          {connected && agentPresets === null && <div className="muted">加载中…</div>}
          {connected && agentPresets && (
            <>
              <div className="preset-grid">
                {(agentPresets as AgentPresetEntry[]).map((p) => (
                  <div key={p.id} className={`p-card ${p.trust === "user" ? "user" : "builtin"}${p.broken ? " broken-card" : ""}`}>
                    <div className="p-card-top">
                      <span className="p-ico">{presetInitial(p)}</span>
                      <span className="p-nm">{p.name ?? p.id}</span>
                      {p.trust === "user" ? <span className="badge user">自定义</span> : <span className="badge builtin">内置</span>}
                      {p.isDefault && <span className="badge def">默认</span>}
                    </div>
                    {p.broken ? (
                      <div className="p-broken">加载失败：{p.broken}</div>
                    ) : (
                      <div className="p-ds">{p.description ?? "（无描述）"}</div>
                    )}
                    <div className="p-ops">
                      {!p.broken && <button className="btn sm" onClick={() => void openView(p)}>查看组装</button>}
                      {!p.broken && (
                        <button
                          className="btn sm"
                          disabled={!agentPresetsMeta?.authorable}
                          title={agentPresetsMeta?.authorable ? "" : "当前部署没有可写预设目录"}
                          onClick={() => openCopy(p)}
                        >
                          复制
                        </button>
                      )}
                      {p.trust === "user" && <button className="btn sm" onClick={() => void appStore.openAgentPresetDocument(p.id)}>打开文件</button>}
                      {!p.broken && !p.isDefault && <button className="btn sm primary" onClick={() => void setDefault(p)}>设为默认</button>}
                      {p.trust === "user" && <button className="btn sm danger-o" onClick={() => setConfirmDelete(p)}>删除</button>}
                    </div>
                  </div>
                ))}
                <div className="dashed-add" onClick={() => void startCreator()}>
                  <span className="da-t">＋ 用「创造模式」创建你自己的 Agent 模式</span>
                  <span className="da-d">让 Agent 在新会话中帮你起草组装文件（plugins / prompt / 能力组合），边做边改。</span>
                </div>
              </div>
              <div className="hint" style={{ marginTop: 10 }}>
                内置模式随 dsh 安装提供（可查看组装 / 复制 / 设为默认，不可删除）；自定义模式可打开文件、复制或删除。复制后描述与组装在预设文件里编辑。
              </div>
            </>
          )}
        </div>
          </>
        )}

        {tab === "plugins" && (
          <>
        <div className="card">
          <div className="card-head">
            <span className="card-title">插件</span>
            <button className="btn sm primary" disabled={!connected} onClick={() => setImportOpen(true)}>＋ 导入插件</button>
          </div>
          <div className="hint" style={{ margin: "8px 0" }}>
            插件 UI 兼容（devContext 0.2.0 条目 6）已降级：spike 结论（dsh 0.1.0-rc.6）显示官方插件 UI 挂载 = cordis + React slot registry（dsh-client-ui-slots）+ 官方 shell（dsh-client-web buildRenderApp），
            无第三方外壳可独立挂载的公开契约。本轮仅提供只读插件清单与启停（受限入口），插件 UI 挂载移出 0.2.0，见 docs/RISKS.md。
          </div>
          {!connected && <div className="muted">dsh 未连接，无法查看插件</div>}
          {connected && plugins === null && <div className="muted">加载中…</div>}
          {connected && plugins && (
            <>
              <div className="tabs-row">
                <button className={`tabp${pluginTab === "all" ? " on" : ""}`} onClick={() => setPluginTab("all")}>全部 {plugins.length}</button>
                <button className={`tabp${pluginTab === "on" ? " on" : ""}`} onClick={() => setPluginTab("on")}>已启用 {plugins.filter((p) => p.enabled).length}</button>
                <button className={`tabp${pluginTab === "off" ? " on" : ""}`} onClick={() => setPluginTab("off")}>已禁用 {plugins.filter((p) => !p.enabled).length}</button>
              </div>
              <div className="plugin-list">
                {plugins.filter((p) => pluginTab === "all" || (pluginTab === "on" ? p.enabled : !p.enabled)).map((p) => (
                  <div key={p.id} className={`plug${p.enabled ? "" : " off"}`}>
                    <span className="plug-ico">{plugInitial(p)}</span>
                    <span className="plug-meta">
                      <span className="plug-nm">
                        {p.id}
                        <span className="plug-mod">{p.name}</span>
                        {p.builtin ? <span className="badge builtin">内置</span> : <span className="badge imported">已导入</span>}
                      </span>
                    </span>
                    <span className={`badge ${p.enabled ? "active" : "off"}`}>{p.enabled ? "已启用" : "已禁用"}</span>
                    {p.conditional ? (
                      <span className="badge cond" title="该插件由 dsh 按平台条件禁用，无法手动启用">插件无法启用</span>
                    ) : (
                      <span
                        className={`switch${p.enabled ? " on" : ""}${pluginBusyId === p.id ? " busy" : ""}`}
                        title={p.builtin ? "内置插件可启用/禁用" : "启用/禁用"}
                        onClick={() => void togglePlugin(p)}
                      />
                    )}
                    {!p.builtin && !p.conditional && <button className="btn sm danger-o" disabled={pluginBusyId === p.id} onClick={() => setPluginDelete(p)}>删除</button>}
                  </div>
                ))}
                {plugins.length === 0 && <div className="muted">暂无插件</div>}
              </div>
              {pluginMsg && <div className="hint" style={{ marginTop: 10 }}>{pluginMsg}</div>}
              <div className="hint" style={{ marginTop: 8 }}>
                启用 / 禁用写入 profile 的 cordis.patch.yml（dsh 热重载）；导入 / 删除调用 pnpm（dsh plugin add/remove），可能需要数分钟，且需要本机安装 pnpm 与网络；删除仅对已导入插件可用。
              </div>
            </>
          )}
        </div>
          </>
        )}

        {tab === "dsh" && (
          <>
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
              <input type="checkbox" checked={form?.proxy_enabled ?? true} disabled={!form} onChange={(e) => set("proxy_enabled", e.currentTarget.checked)} /> 使用网络代理访问模型提供商
            </label>
          </div>
          <div className="f-label">代理地址（留空自动检测系统代理）</div>
          <input type="text" value={form?.proxy_url ?? ""} disabled={running || !form?.proxy_enabled} onChange={(e) => set("proxy_url", e.currentTarget.value || null)} placeholder="如 http://127.0.0.1:7897" />
          <div className="hint">dsh（Node）默认不读环境代理，需显式注入；本机系统代理检测到 http://127.0.0.1:7897 时会自动使用，也可在此覆盖。</div>
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
          </>
        )}
        {tab === "runtime" && <RuntimeManager running={running} />}
        {tab === "wsl" && <WslPanel />}
        {tab === "assist" && <CotSettings />}
        {tab === "assist" && <CotSettings />}
        {/* 复制 Agent 模式对话框 */}
        {copyTarget && (
          <div className="modal-mask" onClick={() => setCopyTarget(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h4>复制预设</h4>
              <div className="hint">在本地完整复制「{copyTarget.name ?? copyTarget.id}」。标识符会成为预设目录名，事后无法更改；描述、组装、技能都在预设文件里编辑。</div>
              <div className="field">
                <label>标识符（目录名）</label>
                <input type="text" value={copyId} onChange={(e) => { setCopyId(e.currentTarget.value); setCopyErr(null); }} placeholder="my-agent" autoFocus />
              </div>
              <div className="field">
                <label>显示名称（可选）</label>
                <input type="text" value={copyName} onChange={(e) => setCopyName(e.currentTarget.value)} placeholder="留空则用标识符" />
              </div>
              {copyErr && <div className="field-err">{copyErr}</div>}
              <div className="modal-row">
                <button className="btn" onClick={() => setCopyTarget(null)}>取消</button>
                <button className="btn primary" onClick={() => void doCopy()}>复制</button>
              </div>
            </div>
          </div>
        )}

        {/* 查看组装（只读） */}
        {viewTarget && (
          <div className="modal-mask" onClick={() => setViewTarget(null)}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
              <h4>{viewTarget.name} · 组装（只读）</h4>
              <div className="hint">内置预设随 dsh 安装提供，组装只读；如想修改，请复制一份。</div>
              <pre className="viewer">{viewTarget.content}</pre>
              <div className="modal-row">
                <button className="btn primary" onClick={() => setViewTarget(null)}>关闭</button>
              </div>
            </div>
          </div>
        )}

        {/* 确认删除 Agent 模式 */}
        {confirmDelete && (
          <div className="modal-mask" onClick={() => setConfirmDelete(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h4>删除自定义模式</h4>
              <div className="hint">将删除整个预设目录「{confirmDelete.name ?? confirmDelete.id}」。已按此模式创建的会话会继续运行，但该模式将不再出现在列表中。</div>
              <div className="modal-row">
                <button className="btn" onClick={() => setConfirmDelete(null)}>取消</button>
                <button
                  className="btn danger-o"
                  onClick={() => {
                    const id = confirmDelete.id;
                    setConfirmDelete(null);
                    void appStore.removeAgentPreset(id).then(() => setAgentMsg(`已删除：${id}`));
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 导入插件对话框 */}
        {importOpen && (
          <div className="modal-mask" onClick={() => { if (!importBusy) setImportOpen(false); }}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h4>导入插件</h4>
              <div className="hint">安装到当前 dsh profile（pnpm，dsh plugin add）。支持 npm 包名、本地目录或 Git 仓库；安装型插件如被 pnpm 拦截，请按提示将 allowBuilds 加入 pnpm-workspace.yaml。</div>
              <div className="field">
                <label>包名 / 本地路径 / Git 仓库</label>
                <input type="text" value={importSpec} onChange={(e) => setImportSpec(e.currentTarget.value)} placeholder="@scope/my-plugin 或 C:\dev\my-plugin 或 https://github.com/user/repo.git" disabled={importBusy} />
              </div>
              <div className="modal-row">
                <button className="btn" disabled={importBusy} onClick={() => setImportOpen(false)}>取消</button>
                <button className="btn primary" disabled={importBusy || !importSpec.trim()} onClick={() => void doImport()}>{importBusy ? "导入中…" : "导入"}</button>
              </div>
            </div>
          </div>
        )}

        {/* 确认删除插件 */}
        {pluginDelete && (
          <div className="modal-mask" onClick={() => setPluginDelete(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h4>删除插件</h4>
              <div className="hint">将执行 dsh plugin remove {pluginDelete.name || pluginDelete.id}（pnpm 卸载）。可能需要重启 dsh 后生效。</div>
              <div className="modal-row">
                <button className="btn" onClick={() => setPluginDelete(null)}>取消</button>
                <button className="btn danger-o" onClick={() => void deletePlugin(pluginDelete)}>删除</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}





