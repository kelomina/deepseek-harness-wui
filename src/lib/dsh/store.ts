import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { dsh, onDshLog, onDshStatus, type DshConfig, type DshStatus } from "../tauri";
import { DshApiClient } from "./client";
import { computeRevertInfo, type RevertInfo } from "./revert";
import { sessionTitle } from "./sessionTitle";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  AgentPresetEntry,
  ApprovalResponsePayload,
  ConfigurableProviderView,
  CredentialView,
  DiscoveredModelView,
  HostFrame,
  ModelProviderGroup,
  MuxFrame,
  QuestionResponsePayload,
  RpcId,
  SessionSummary,
  SettingsNamespaceView,
  SettingsPathOpView,
  WorkspaceId,
  WorkspaceView,
} from "@deepseek-ai/dsh-host-apiproxy/api";

export interface HostDescription {
  version: string;
  cwd: string;
  provider?: string;
  model?: string;
  attachedSessions: number;
  canOpenPath: boolean;
}

export interface InteractiveItem {
  rpcId: RpcId;
  kind: "approval" | "question";
  sessionId: SessionId;
  frame: MuxFrame;
}

export interface LiveStream {
  turn: number;
  step: number;
  reasoning: string;
  text: string;
  finished: boolean;
}

export interface AgentPresetMeta {
  authorable: boolean;
  hasDocument: boolean;
}

export interface PermissionSelect {
  options: Array<{ value: string; name: string; description?: string }>;
  currentValue: string;
}

export interface AppState {
  status: DshStatus | null;
  config: DshConfig | null;
  logs: string[];
  api: DshApiClient | null;
  connected: boolean;
  host: HostDescription | null;
  workspaces: WorkspaceView[];
  sessions: SessionSummary[];
  sessionTitles: Record<string, string>;
  interactives: InteractiveItem[];
  live: Map<SessionId, MuxFrame[]>;
  selectedSessionId: SessionId | null;
  activeWorkspaceId: WorkspaceId | null;
  hiddenPresets: string[];
  pinnedSessions: SessionId[];
  selectedModel: { provider: string; model: string } | null;
  selectedReasoning: string | null;
  modelGroups: ModelProviderGroup[] | null;
  history: Map<SessionId, unknown[]>;
  streams: Map<SessionId, LiveStream>;
  archivedSessionIds: SessionId[];
  agentPresets: AgentPresetEntry[] | null;
  agentPresetsMeta: AgentPresetMeta | null;
  pendingAgentPreset: string | null;
  sessionPermissions: Map<SessionId, PermissionSelect>;
  /** 会话当前模型 id 缓存（用于 V4-Pro 思维链检测等按会话功能）。 */
  sessionModels: Map<SessionId, string>;
  /** 会话点击停止后进入「正在停止」的时间戳（毫秒）。 */
  stoppingSessions: Record<SessionId, number>;
  /** 用户点击停止后冻结该会话的流式快照（不再追加内容），直到下一轮开始。 */
  forceFinished: SessionId[];
  /** 停止行为的可复查证据：cancel RPC 结果与 turn/end(aborted) 时间戳。 */
  stopEvidence: Record<SessionId, { cancelAcceptedAt?: number; cancelError?: string; turnEndAbortedAt?: number; stoppedUiAt?: number }>;
  /** 非错误提示（例如撤回/重试的结果说明）。 */
  notice: string | null;
  loading: boolean;
  error: string | null;
}

const initialState: AppState = {
  status: null,
  config: null,
  logs: [],
  api: null,
  connected: false,
  host: null,
  workspaces: [],
  sessions: [],
  sessionTitles: {},
  interactives: [],
  live: new Map(),
  selectedSessionId: null,
  activeWorkspaceId: null,
  hiddenPresets: [],
  pinnedSessions: [],
  selectedModel: null,
  selectedReasoning: null,
  modelGroups: null,
  history: new Map(),
  streams: new Map(),
  archivedSessionIds: [],
  agentPresets: null,
  agentPresetsMeta: null,
  pendingAgentPreset: null,
  sessionPermissions: new Map(),
  sessionModels: new Map(),
  stoppingSessions: {},
  forceFinished: [],
  stopEvidence: {},
  notice: null,
  loading: false,
  error: null,
};

class AppStore {
  private state: AppState = initialState;
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private unlisteners: Array<() => void> = [];
  private started = false;
  private historySyncTimers = new Map<string, number>();

  get = (): AppState => {
    return this.state;
  };

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  set(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((fn) => fn());
  }

  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const [status, config] = await Promise.all([dsh.status(), dsh.getConfig()]);
    let hiddenPresets: string[] = [];
    let pinnedSessions: SessionId[] = [];
    let selectedModel: { provider: string; model: string } | null = null;
    let selectedReasoning: string | null = null;
    try {
      hiddenPresets = JSON.parse(window.localStorage.getItem("hiddenPresets") ?? "[]") as string[];
      pinnedSessions = JSON.parse(window.localStorage.getItem("pinnedSessions") ?? "[]") as SessionId[];
      selectedModel = JSON.parse(window.localStorage.getItem("selectedModel") ?? "null") as { provider: string; model: string } | null;
      selectedReasoning = window.localStorage.getItem("selectedReasoning") as string | null;
    } catch {
      hiddenPresets = [];
      pinnedSessions = [];
      selectedModel = null;
      selectedReasoning = null;
    }
    // Rust 配置中的模型选择优先（跨重启保留）
    if (config.selected_provider && config.selected_model) {
      selectedModel = { provider: config.selected_provider, model: config.selected_model };
    }
    if (config.selected_reasoning) {
      selectedReasoning = config.selected_reasoning;
    }
    this.set({ status, config, hiddenPresets, pinnedSessions, selectedModel, selectedReasoning });
    // 旧版本 localStorage 选择迁移到 Rust 配置
    if (selectedModel && !(config.selected_provider && config.selected_model)) {
      void invoke("dsh_set_selected_model", { provider: selectedModel.provider, model: selectedModel.model }).catch(() => {});
    }
    this.unlisteners.push(
      await onDshStatus((s) => {
        this.set({ status: s });
        void this.syncConnection();
      }),
    );
    this.unlisteners.push(
      await onDshLog((line) => this.set({ logs: [...this.state.logs.slice(-499), line] })),
    );
    window.setInterval(async () => {
      try {
        const s = await dsh.status();
        this.set({ status: s });
        void this.syncConnection();
      } catch {
        // ignore transient poll failures
      }
    }, 5000);
    void this.syncConnection();
  }

  private async syncConnection(): Promise<void> {
    const status = this.state.status;
    if (!status) return;
    if (status.state === "running" && !this.state.api) {
      await this.connect(status.proxy_port);
    } else if (status.state !== "running" && this.state.api) {
      this.disconnect();
    }
  }

  private async connect(proxyPort: number): Promise<void> {
    const api = new DshApiClient(`http://127.0.0.1:${proxyPort}`);
    const abort = new AbortController();
    this.abort = abort;
    this.set({ api, connected: false, error: null });
    try {
      const desc = await api.host.describe({});
      if (desc.result.ok) this.set({ host: desc.result.value as HostDescription });
      const ws = await api.workspace.list({});
      if (ws.result.ok) this.set({ workspaces: ws.result.value.items, archivedSessionIds: ws.result.value.archivedSessionIds });
      const sess = await api.sessions.list({});
      if (sess.result.ok) {
        this.set({ sessions: sess.result.value.items, sessionTitles: this.seedSessionTitles(sess.result.value.items) });
      }
      void this.loadAgentPresets();
      this.set({ connected: true });
      void this.loadModels();
      if (this.state.selectedSessionId) {
        void this.loadHistory(this.state.selectedSessionId).catch((e) => this.set({ error: `历史加载失败: ${String(e)}` }));
      }
      void this.pump(api.events.mux({}, abort.signal), "mux");
      void this.pump(api.events.host({}, abort.signal), "host");
    } catch (e) {
      this.set({ error: `连接失败: ${String(e)}`, connected: false, api: null });
    }
  }

  private disconnect(): void {
    this.abort?.abort();
    this.abort = null;
    this.set({
      api: null,
      connected: false,
      host: null,
      workspaces: [],
      sessions: [],
      interactives: [],
      streams: new Map(),
      archivedSessionIds: [],
      sessionPermissions: new Map(),
      sessionModels: new Map(),
      stoppingSessions: {},
      forceFinished: [],
      stopEvidence: {},
      notice: null,
    });
  }

  private async pump(stream: AsyncIterable<unknown>, kind: "mux" | "host"): Promise<void> {
    try {
      for await (const envelope of stream as AsyncIterable<{ rpcId: RpcId; payload: unknown }>) {
        if (kind === "mux") this.dispatchMux(envelope);
        else this.dispatchHost(envelope);
      }
    } catch (e) {
      this.set({ error: `事件流中断: ${String(e)}` });
    } finally {
      if (this.abort) this.set({ connected: false });
    }
  }

  private dispatchMux(envelope: { rpcId: RpcId; payload: unknown }): void {
    const frame = envelope.payload as MuxFrame;
    switch (frame.type) {
      case "session/event": {
        const arr = this.state.live.get(frame.sessionId) ?? [];
        arr.push(frame);
        if (arr.length > 600) arr.shift();
        const live = new Map(this.state.live);
        live.set(frame.sessionId, arr);
        const streams = this.mergeStream(frame);
        this.set({ live, streams });
        if (frame.event.type === "assistant/message") {
          this.scheduleHistorySync(frame.sessionId);
        }
        const rawEvent = frame.event as { type?: string; data?: { title?: string } };
        if (rawEvent.type === "session/title") {
          const title = rawEvent.data?.title;
          if (title) {
            this.set({ sessionTitles: { ...this.state.sessionTitles, [frame.sessionId]: title } });
          }
        }
        if (frame.event.type === "turn/start") {
          // 新一轮开始：解除停止冻结，允许继续流式
          const stopping = { ...this.state.stoppingSessions };
          delete stopping[frame.sessionId];
          this.set({
            stoppingSessions: stopping,
            forceFinished: this.state.forceFinished.filter((id) => id !== frame.sessionId),
          });
        }
        if (frame.event.type === "turn/end") {
          // 记录停止证据（dsh 可观察会话状态）：turn/end 到达，reason 为 aborted 表示后端已终止
          const reason = (frame.event.data as { reason?: { kind?: string } })?.reason?.kind;
          const stopping = { ...this.state.stoppingSessions };
          delete stopping[frame.sessionId];
          const ev0 = { ...(this.state.stopEvidence[frame.sessionId] ?? {}) };
          if (reason === "aborted") ev0.turnEndAbortedAt = Date.now();
          this.set({
            stoppingSessions: stopping,
            stopEvidence: { ...this.state.stopEvidence, [frame.sessionId]: ev0 },
          });
        }
        break;
      }
      case "approval/requested":
        this.set({
          interactives: [
            ...this.state.interactives.filter(
              (i) => !(i.kind === "approval" && i.frame.type === "approval/requested" && i.frame.approvalId === frame.approvalId),
            ),
            { rpcId: envelope.rpcId, kind: "approval", sessionId: frame.sessionId, frame },
          ],
        });
        break;
      case "approval/resolved":
        this.set({
          interactives: this.state.interactives.filter(
            (i) => !(i.kind === "approval" && i.frame.type === "approval/requested" && i.frame.approvalId === frame.approvalId),
          ),
        });
        break;
      case "question/requested":
        this.set({
          interactives: [
            ...this.state.interactives.filter((i) => i.kind !== "question"),
            { rpcId: envelope.rpcId, kind: "question", sessionId: frame.sessionId, frame },
          ],
        });
        break;
      case "question/resolved":
        this.set({ interactives: this.state.interactives.filter((i) => i.kind !== "question") });
        break;
      default:
        break;
    }
  }

  /** 累积流式 assistant/chunk，为每个会话维护一份进行中的回复快照（不受 live 600 帧上限影响）。 */
  private mergeStream(frame: MuxFrame): Map<SessionId, LiveStream> {
    if (frame.type !== "session/event") return this.state.streams;
    const ev = frame.event;
    const sid = frame.sessionId;
    const cur = this.state.streams.get(sid);
    // 用户点击停止后冻结显示：不再追加流式内容（直到下一轮 turn/start 解除）。
    if (this.state.forceFinished.includes(sid) && ev.type !== "turn/end") return this.state.streams;
    let next: LiveStream | null = null;
    if (ev.type === "assistant/chunk") {
      const data = ev.data as { turn: number; step: number; chunk?: { type?: string; text?: string } };
      const chunk = data.chunk ?? {};
      const base =
        cur && cur.turn === data.turn && cur.step === data.step
          ? cur
          : { turn: data.turn, step: data.step, reasoning: "", text: "", finished: false };
      next = {
        ...base,
        reasoning: chunk.type === "reasoning-delta" ? base.reasoning + (chunk.text ?? "") : base.reasoning,
        text: chunk.type === "text-delta" ? base.text + (chunk.text ?? "") : base.text,
        // finish chunk 不立即隐藏：等 assistant/message 到达后再切换，避免闪烁
        finished: base.finished,
      };
    } else if (ev.type === "assistant/message" && cur) {
      const data = ev.data as { turn?: number; step?: number };
      if (cur.turn === data.turn && cur.step === data.step) {
        next = { ...cur, finished: true };
      }
    } else if (ev.type === "turn/end" && cur) {
      // turn 结束兜底：未收到 assistant/message（如错误/取消）时不再展示进行中快照
      next = { ...cur, finished: true };
    }
    if (!next) return this.state.streams;
    const streams = new Map(this.state.streams);
    streams.set(sid, next);
    return streams;
  }

  private dispatchHost(envelope: { rpcId: RpcId; payload: unknown }): void {
    const frame = envelope.payload as HostFrame;
    switch (frame.type) {
      case "host/session-added":
      case "host/session-removed":
      case "host/session-status": {
        void this.refreshSessions();
        const sf = frame as { type: "host/session-status"; sessionId: SessionId; running: boolean };
        if (!sf.running) {
          const stopping = { ...this.state.stoppingSessions };
          delete stopping[sf.sessionId];
          this.set({ stoppingSessions: stopping });
        }
        break;
      }
      case "host/archived-sessions-changed":
        this.set({ archivedSessionIds: frame.archivedSessionIds });
        void this.refreshSessions();
        break;
      case "host/workspace-changed":
      case "host/workspace-removed":
      case "host/workspace-order-changed":
        void this.refreshWorkspaces();
        break;
      case "host/agent-error":
        this.set({ error: `agent 错误: ${frame.message}` });
        break;
      default:
        break;
    }
  }

  /** 从会话列表投影播种本地标题表（保留本地已设置标题，投影缺失不覆盖）。 */
  private seedSessionTitles(items: SessionSummary[]): Record<string, string> {
    const next: Record<string, string> = { ...this.state.sessionTitles };
    for (const s of items) {
      const t = sessionTitle(s);
      if (t) next[s.sessionId] = t;
    }
    return next;
  }

  private requireApi(): DshApiClient {
    if (!this.state.api) throw new Error("dsh 未连接");
    return this.state.api;
  }

  async refreshSessions(): Promise<void> {
    if (!this.state.api) return;
    const r = await this.state.api.sessions.list({});
    if (r.result.ok) {
      this.set({ sessions: r.result.value.items, sessionTitles: this.seedSessionTitles(r.result.value.items) });
    }
  }

  async refreshWorkspaces(): Promise<void> {
    if (!this.state.api) return;
    const r = await this.state.api.workspace.list({});
    if (r.result.ok) this.set({ workspaces: r.result.value.items, archivedSessionIds: r.result.value.archivedSessionIds });
  }

  setActiveWorkspace(workspaceId: WorkspaceId | null): void {
    this.set({ activeWorkspaceId: workspaceId });
  }

  async createSession(workspaceId?: WorkspaceId): Promise<SessionId | null> {
    const api = this.requireApi();
    const wid = workspaceId ?? this.state.activeWorkspaceId;
    const r = await api.sessions.create({ workspaceId: wid ?? undefined });
    if (r.result.ok) {
      const id = r.result.value.sessionId;
      this.set({ selectedSessionId: id });
      const sel = this.state.selectedModel;
      if (sel) {
        try {
          await api.sessions.selectModel({
            sessionId: id,
            provider: sel.provider,
            model: sel.model,
            reasoningEffort: this.state.selectedReasoning ?? undefined,
          });
        } catch {
          // 模型选择失败不阻断会话创建
        }
      }
      const preset = this.state.pendingAgentPreset;
      if (preset) {
        try {
          await api.agentPresets.select({ sessionId: id, agentPreset: preset });
        } catch (e) {
          this.set({ error: `Agent 模式应用失败: ${String(e)}` });
        }
        this.set({ pendingAgentPreset: null });
      }
      await this.refreshSessions();
      return id;
    }
    this.set({ error: `创建会话失败: ${r.result.error.code}: ${r.result.error.message}` });
    return null;
  }

  async sendPrompt(sessionId: SessionId, text: string): Promise<void> {
    const api = this.requireApi();
    const r = await api.sessions.prompt({
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
    });
    if (!r.result.ok) {
      this.set({ error: `发送失败: ${r.result.error.code}: ${r.result.error.message}` });
      return;
    }
    window.setTimeout(() => {
      void this.loadHistory(sessionId).catch(() => {});
    }, 1500);
  }

  /**
   * 停止当前生成（devContext 条目 5）。
   * - 点击后立即进入「正在停止」状态；2s 默认时限内 UI 切换为已停止（前端止流降级，
   *   时限调整需在 docs/RISKS.md 记录原因）。
   * - 调用官方中断 RPC sessions.cancel；ok 时记录 cancelAcceptedAt 证据。
   * - 冻结该会话的流式快照（不再追加内容），直到下一轮 turn/start 解除。
   * - cancel 失败或 dsh 不支持中断时记录 cancelError，明确不把「前端停止」包装成「后端已终止」。
   */
  async stopSession(sessionId: SessionId): Promise<void> {
    const now = Date.now();
    const stopping = { ...this.state.stoppingSessions, [sessionId]: now };
    this.set({
      stoppingSessions: stopping,
      forceFinished: this.state.forceFinished.includes(sessionId)
        ? this.state.forceFinished
        : [...this.state.forceFinished, sessionId],
    });
    const api = this.state.api;
    const base = this.state.stopEvidence[sessionId] ?? {};
    if (!api) {
      this.set({ stopEvidence: { ...this.state.stopEvidence, [sessionId]: { ...base, stoppedUiAt: now } } });
      return;
    }
    try {
      const r = await api.sessions.cancel({ sessionId });
      if (r.result.ok) {
        this.set({
          stopEvidence: { ...this.state.stopEvidence, [sessionId]: { ...base, cancelAcceptedAt: Date.now() } },
        });
      } else {
        this.set({
          error: `停止失败（已降级为前端止流）: ${r.result.error.code}: ${r.result.error.message}`,
          stopEvidence: { ...this.state.stopEvidence, [sessionId]: { ...base, cancelError: `${r.result.error.code}: ${r.result.error.message}` } },
        });
      }
    } catch (e) {
      this.set({
        error: `停止失败（已降级为前端止流）: ${String(e)}`,
        stopEvidence: { ...this.state.stopEvidence, [sessionId]: { ...base, cancelError: String(e) } },
      });
    } finally {
      // 默认时限 2s：无论后端是否确认，UI 都进入「已停止」状态（前端止流降级路径）。
      window.setTimeout(() => {
        const stopping2 = { ...this.state.stoppingSessions };
        delete stopping2[sessionId];
        this.set({
          stoppingSessions: stopping2,
          stopEvidence: { ...this.state.stopEvidence, [sessionId]: { ...(this.state.stopEvidence[sessionId] ?? {}), stoppedUiAt: Date.now() } },
        });
      }, 2000);
    }
  }

  /** 停止当前生成（兼容旧调用名）。 */
  cancelSession(sessionId: SessionId): Promise<void> {
    return this.stopSession(sessionId);
  }

  /**
   * 重试语义（devContext 条目 10）：撤回该消息 + 重发该消息。
   * dsh 0.1.0-rc.6 协议不支持「当前会话内撤回」（仅 sessions.fork 可新建会话），
   * 因此按协议降级：fork 到该消息之前的轮次边界（等价于撤回），在新会话中重发；
   * 新会话上下文里该消息只出现一次，可用会话历史验证（验证边界见 docs/RISKS.md）。
   */
  async retryMessage(sessionId: SessionId, seq: number, text: string): Promise<void> {
    const api = this.requireApi();
    const info = await this.collectRevertInfo(sessionId, seq);
    if (info.prevTurnEnd === null) {
      this.set({ error: "这是首条消息，dsh 无法回退到更早位置；无法按「撤回+重发」语义重试" });
      return;
    }
    try {
      const r = await api.sessions.fork({ sessionId, atSeq: info.prevTurnEnd });
      if (!r.result.ok) {
        this.set({ error: `重试失败（撤回阶段）: ${r.result.error.code}: ${r.result.error.message}` });
        return;
      }
      const newId = r.result.value.sessionId;
      this.set({
        selectedSessionId: newId,
        notice: `已按「撤回+重发」重试：dsh 无同会话撤回协议，已在原会话基础上创建新会话 ${newId} 并重发消息（原会话保留）。`,
      });
      await this.refreshSessions();
      await this.loadHistory(newId);
      const p = await api.sessions.prompt({ sessionId: newId, mode: "queue", content: [{ type: "text", text }] });
      if (!p.result.ok) {
        this.set({ error: `重发失败: ${p.result.error.code}: ${p.result.error.message}` });
        return;
      }
      window.setTimeout(() => {
        void this.loadHistory(newId).catch(() => {});
      }, 1500);
    } catch (e) {
      this.set({ error: `重试失败: ${String(e)}` });
    }
  }


  async loadHistory(sessionId: SessionId): Promise<void> {
    const api = this.requireApi();
    const r = await api.sessions.history({ sessionId, maxMessages: 200 });
    if (r.result.ok) {
      const history = new Map(this.state.history);
      history.set(sessionId, r.result.value.events);
      const patch: Partial<AppState> = { history };
      // 会话权限投影（tail 页 projections.values.permissions）
      const proj = r.result.value.projections as { values?: Record<string, unknown> } | undefined;
      const perm = proj?.values?.permissions as PermissionSelect | undefined;
      if (perm) {
        const m = new Map(this.state.sessionPermissions);
        m.set(sessionId, perm);
        patch.sessionPermissions = m;
      }
      this.set(patch);
    }
  }

  /** 会话当前模型 id（缓存；读取 session.models.current.model，失败返回 null）。 */
  async getSessionModelId(sessionId: SessionId): Promise<string | null> {
    const cached = this.state.sessionModels.get(sessionId);
    if (cached) return cached;
    const api = this.state.api;
    if (!api) return null;
    try {
      const r = await api.sessions.models({ sessionId });
      if (r.result.ok) {
        const id = (r.result.value as { current?: { model?: string } }).current?.model ?? null;
        if (id) {
          const m = new Map(this.state.sessionModels);
          m.set(sessionId, id);
          this.set({ sessionModels: m });
        }
        return id;
      }
    } catch {
      // 读取失败不阻断
    }
    return null;
  }

  async addWorkspace(path: string): Promise<WorkspaceId | null> {
    const api = this.requireApi();
    const r = await api.workspace.create({ path });
    if (r.result.ok) {
      await this.refreshWorkspaces();
      const id = r.result.value.workspace.workspaceId;
      this.set({ activeWorkspaceId: id });
      return id;
    }
    this.set({ error: `添加工作区失败: ${r.result.error.code}: ${r.result.error.message}` });
    return null;
  }

  async deleteWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const api = this.requireApi();
    const r = await api.workspace.delete({ workspaceId });
    if (!r.result.ok) {
      this.set({ error: `删除工作区失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
    await this.refreshWorkspaces();
  }

  async renameWorkspace(workspaceId: WorkspaceId, title: string): Promise<void> {
    const api = this.requireApi();
    const r = await api.workspace.rename({ workspaceId, title });
    if (!r.result.ok) {
      this.set({ error: `重命名失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
    await this.refreshWorkspaces();
  }

  async answerApproval(item: InteractiveItem, outcome: "allowed-once" | "rejected"): Promise<void> {
    const api = this.requireApi();
    if (item.frame.type !== "approval/requested") return;
    const payload: ApprovalResponsePayload = {
      sessionId: item.sessionId,
      approvalId: item.frame.approvalId,
      outcome,
    };
    await api.respond({ type: "client-response", rpcId: item.rpcId, result: { ok: true, value: payload } });
    this.set({ interactives: this.state.interactives.filter((i) => i !== item) });
  }

  async answerQuestion(item: InteractiveItem, text: string): Promise<void> {
    const api = this.requireApi();
    const payload: QuestionResponsePayload = {
      sessionId: item.sessionId,
      answer: { type: "text", text } as never,
    };
    await api.respond({ type: "client-response", rpcId: item.rpcId, result: { ok: true, value: payload } });
    this.set({ interactives: this.state.interactives.filter((i) => i !== item) });
  }

  async pickDirectory(): Promise<string | null> {
    const api = this.requireApi();
    const r = await api.host.pickDirectory({}, new AbortController().signal);
    if (r.result.ok) return r.result.value.path;
    throw new Error(`目录选择不可用: ${r.result.error.message || r.result.error.code}`);
  }

  async listDirectory(path?: string) {
    const api = this.requireApi();
    return api.host.listDirectory({ path }, new AbortController().signal);
  }

  async createDirectory(path: string, name: string) {
    const api = this.requireApi();
    return api.host.createDirectory({ path, name });
  }

  async getSettingsNamespace(ns: string): Promise<SettingsNamespaceView | null> {
    const api = this.requireApi();
    const r = await api.settings.describe({});
    if (r.result.ok) return r.result.value.namespaces.find((n) => n.ns === ns) ?? null;
    throw new Error(`读取设置失败: ${r.result.error.code}: ${r.result.error.message}`);
  }

  async mutateSettings(ns: string, ops: SettingsPathOpView[]): Promise<void> {
    const api = this.requireApi();
    const r = await api.settings.mutate({ ns, ops });
    if (!r.result.ok) {
      throw new Error(`设置被拒绝: ${r.result.error.message || r.result.error.code}`);
    }
  }

  async listProviders(): Promise<ConfigurableProviderView[]> {
    const api = this.requireApi();
    const r = await api.llm.providers({});
    if (r.result.ok) return r.result.value.providers;
    throw new Error(`获取模型提供商失败: ${r.result.error.code}: ${r.result.error.message}`);
  }

  async describeCredentials(refs: string[]): Promise<Record<string, CredentialView>> {
    const api = this.requireApi();
    const r = await api.credentials.describe({ refs });
    if (r.result.ok) return r.result.value.credentials;
    throw new Error(`读取凭据状态失败: ${r.result.error.code}: ${r.result.error.message}`);
  }

  async setCredential(ref: string, value: string): Promise<void> {
    const api = this.requireApi();
    const r = await api.credentials.set({ ref, value });
    if (!r.result.ok) {
      throw new Error(`保存凭据失败: ${r.result.error.code}: ${r.result.error.message}`);
    }
  }

  async unsetCredential(ref: string): Promise<void> {
    const api = this.requireApi();
    const r = await api.credentials.unset({ ref });
    if (!r.result.ok) {
      throw new Error(`清除凭据失败: ${r.result.error.code}: ${r.result.error.message}`);
    }
  }

  async discoverModels(opts: { settingsNs: string; provider?: string; baseURL?: string; api?: string; apiKey?: string }): Promise<DiscoveredModelView[]> {
    const api = this.requireApi();
    const r = await api.llm.discoverModels(opts);
    if (r.result.ok) return r.result.value.models;
    throw new Error(`探测失败: ${r.result.error.message || r.result.error.code}`);
  }

  async loadModels(): Promise<void> {
    try {
      const groups = await this.listModels();
      this.set({ modelGroups: groups });
    } catch {
      // 目录加载失败不阻塞
    }
  }

  async listModels(): Promise<ModelProviderGroup[]> {
    const api = this.requireApi();
    const r = await api.llm.models({});
    if (r.result.ok) return r.result.value.groups;
    throw new Error(`获取模型目录失败: ${r.result.error.code}: ${r.result.error.message}`);
  }

  setSelectedReasoning(id: string | null): void {
    try {
      if (id) {
        window.localStorage.setItem("selectedReasoning", id);
      } else {
        window.localStorage.removeItem("selectedReasoning");
      }
    } catch {
      // ignore storage failures
    }
    this.set({ selectedReasoning: id });
    const sel = this.state.selectedModel;
    if (sel) {
      void invoke("dsh_set_selected_model", { provider: sel.provider, model: sel.model, reasoning: id ?? null })
        .catch((e) => this.set({ error: `思考强度保存失败: ${String(e)}` }));
    }
  }

  setSelectedModel(sel: { provider: string; model: string } | null): void {
    try {
      window.localStorage.setItem("selectedModel", JSON.stringify(sel));
    } catch {
      // ignore storage failures
    }
    this.set({ selectedModel: sel });
    if (sel) {
      void invoke("dsh_set_selected_model", { provider: sel.provider, model: sel.model, reasoning: this.state.selectedReasoning ?? null })
        .catch((e) => this.set({ error: `模型选择保存失败: ${String(e)}` }));
    }
  }

  hidePreset(provider: string): void {
    const list = [...this.state.hiddenPresets.filter((p) => p !== provider), provider];
    try {
      window.localStorage.setItem("hiddenPresets", JSON.stringify(list));
    } catch {
      // ignore storage failures
    }
    this.set({ hiddenPresets: list });
  }

  unhidePreset(provider: string): void {
    const list = this.state.hiddenPresets.filter((p) => p !== provider);
    try {
      window.localStorage.setItem("hiddenPresets", JSON.stringify(list));
    } catch {
      // ignore storage failures
    }
    this.set({ hiddenPresets: list });
  }

  private scheduleHistorySync(sessionId: SessionId): void {
    const existing = this.historySyncTimers.get(sessionId);
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      this.historySyncTimers.delete(sessionId);
      void this.loadHistory(sessionId).catch(() => {});
    }, 500);
    this.historySyncTimers.set(sessionId, timer);
  }
  async collectRevertInfo(sessionId: SessionId, seq: number): Promise<RevertInfo> {
    const events = (this.state.history.get(sessionId) ?? []) as Array<{
      seq: number;
      event: { type: string; seq: number };
      view?: { view?: { diffs?: Array<{ path: string; oldText: string | null; newText: string }> } };
    }>;
    return computeRevertInfo(events, seq);
  }

  async retractMessage(sessionId: SessionId, seq: number, revertFiles: boolean): Promise<void> {
    const api = this.requireApi();
    const info = await this.collectRevertInfo(sessionId, seq);
    if (info.prevTurnEnd === null) {
      this.set({ error: "这是首条消息，dsh 无法回退到更早位置；可继续对话或归档会话" });
      return;
    }
    try {
      const r = await api.sessions.fork({ sessionId, atSeq: info.prevTurnEnd });
      if (!r.result.ok) {
        this.set({ error: `撤回失败: ${r.result.error.code}: ${r.result.error.message}` });
        return;
      }
      const newId = r.result.value.sessionId;
      const errors: string[] = [];
      if (revertFiles) {
        const sess = this.state.sessions.find((s) => s.sessionId === sessionId);
        const root = sess?.cwd ?? this.state.host?.cwd;
        if (root) {
          // 全部 diff 按 seq 降序（逆序还原）
          const all = info.files
            .flatMap((f) => f.diffs.map((d) => ({ path: f.path, seq: d.seq, oldText: d.oldText, newText: d.newText })))
            .sort((a, b) => b.seq - a.seq);
          for (const d of all) {
            try {
              await invoke("fs_revert", { root, path: d.path, expected: d.newText, oldText: d.oldText ?? null });
            } catch (e) {
              errors.push(`${d.path}: ${String(e).slice(0, 120)}`);
            }
          }
          // 用 git 恢复被删除的文件（HEAD 中存在且当前缺失时）
          try {
            const restored = await invoke<string[]>("git_restore_deleted", { root });
            if (restored.length) {
              errors.push(`已用 git 恢复被删除文件: ${restored.slice(0, 5).join(", ")}${restored.length > 5 ? "…" : ""}`);
            }
          } catch (e) {
            const msg = String(e);
            if (!msg.includes("不是 git 仓库")) {
              errors.push(`git 恢复被删文件失败: ${msg.slice(0, 120)}`);
            }
          }
        }
      }
      this.set({
        selectedSessionId: newId,
        error: errors.length ? `已撤回，但 ${errors.length} 处文件回退失败：${errors.slice(0, 3).join("；")}` : null,
        notice: `已撤回：dsh 0.1.0-rc.6 不支持「当前会话内撤回」（仅 sessions.fork 可新建会话），已在原会话基础上创建新会话 ${newId}；原会话保留未动，文件修改${revertFiles ? "已" : "未"}回退。`,
      });
      await this.refreshSessions();
      await this.loadHistory(newId);
    } catch (e) {
      this.set({ error: `撤回失败: ${String(e)}` });
    }
  }

  /** 从某条消息处把会话分叉为新会话（dsh 语义：atSeq=消息 seq，包含该消息所在整轮）。 */
  async forkAt(sessionId: SessionId, seq: number): Promise<void> {
    const api = this.requireApi();
    try {
      const r = await api.sessions.fork({ sessionId, atSeq: seq });
      if (!r.result.ok) {
        this.set({ error: `分叉失败: ${r.result.error.code}: ${r.result.error.message}` });
        return;
      }
      const newId = r.result.value.sessionId;
      this.set({ selectedSessionId: newId });
      await this.refreshSessions();
      await this.loadHistory(newId);
    } catch (e) {
      this.set({ error: `分叉失败: ${String(e)}` });
    }
  }

  async loadAgentPresets(): Promise<void> {
    const api = this.requireApi();
    try {
      const r = await api.agentPresets.list({});
      if (r.result.ok) {
        this.set({
          agentPresets: r.result.value.presets as AgentPresetEntry[],
          agentPresetsMeta: { authorable: r.result.value.authorable, hasDocument: r.result.value.hasDocument },
        });
      } else {
        this.set({ error: `读取 Agent 模式失败: ${r.result.error.code}: ${r.result.error.message}` });
      }
    } catch (e) {
      this.set({ error: `读取 Agent 模式失败: ${String(e)}` });
    }
  }

  setPendingAgentPreset(id: string | null): void {
    this.set({ pendingAgentPreset: id });
  }

  /** 立即以指定 Agent 预设创建一个新会话（用于「创造模式」引导卡）。 */
  async createSessionWithAgentPreset(agentPreset: string): Promise<SessionId | null> {
    const api = this.requireApi();
    const wid = this.state.activeWorkspaceId;
    const r = await api.sessions.create({ workspaceId: wid ?? undefined });
    if (!r.result.ok) {
      this.set({ error: `创建会话失败: ${r.result.error.code}: ${r.result.error.message}` });
      return null;
    }
    const id = r.result.value.sessionId;
    this.set({ selectedSessionId: id });
    try {
      await api.agentPresets.select({ sessionId: id, agentPreset });
    } catch (e) {
      this.set({ error: `Agent 模式应用失败: ${String(e)}` });
    }
    await this.refreshSessions();
    await this.loadHistory(id);
    return id;
  }

  /** 对指定会话应用 Agent 模式（仅空白会话可改，dsh 会拒绝已开始会话）。 */
  async applyAgentPresetToSession(sessionId: SessionId, agentPreset: string): Promise<void> {
    const api = this.requireApi();
    try {
      const r = await api.agentPresets.select({ sessionId, agentPreset });
      if (!r.result.ok) {
        this.set({ error: `更换 Agent 模式失败: ${r.result.error.code}: ${r.result.error.message}` });
        return;
      }
      await this.refreshSessions();
    } catch (e) {
      this.set({ error: `更换 Agent 模式失败: ${String(e)}` });
    }
  }

  /** 手动重命名会话（dsh 追加 user 源 session/title，固定标题不被自动重命名覆盖）。 */
  async renameSession(sessionId: SessionId, title: string): Promise<void> {
    const api = this.requireApi();
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const r = await api.sessions.rename({ sessionId, title: trimmed });
      if (!r.result.ok) {
        this.set({ error: `重命名失败: ${r.result.error.code}: ${r.result.error.message}` });
        return;
      }
      // 本地标题立即生效（冷会话 list 无投影时也能显示），再刷新列表投影
      this.set({ sessionTitles: { ...this.state.sessionTitles, [sessionId]: trimmed } });
      await this.refreshSessions();
    } catch (e) {
      this.set({ error: `重命名失败: ${String(e)}` });
    }
  }

  /**
   * 设置「未来新会话」的默认权限预设（permission settings 命名空间，live 生效）。
   * 注：切换「当前会话」权限是 dsh 宿主侧 `/permission` 命令（Typert commands.execute，
   * 外部浏览器客户端经 apiproxy 无法调用，且经 session.prompt 发送会被当作普通消息触发模型回合）。
   */
  async setDefaultPermissionPreset(preset: string): Promise<void> {
    try {
      await this.mutateSettings("permission", [{ op: "set", path: ["defaultPreset"], value: preset }]);
    } catch (e) {
      this.set({ error: `设置默认权限失败: ${String(e)}` });
    }
  }

  /** 读取 permission 设置命名空间（含 schema 枚举），返回默认权限选项与当前值。 */
  async getPermissionOptions(): Promise<{ options: Array<{ value: string; name: string }>; current: string | null }> {
    const ns = await this.getSettingsNamespace("permission");
    const value = (ns?.value ?? {}) as { defaultPreset?: string };
    const options = permissionSchemaEnums(ns?.schema).map((v) => ({ value: v, name: v }));
    return { options, current: value.defaultPreset ?? null };
  }

  async setDefaultAgentPreset(id: string): Promise<void> {
    try {
      await this.mutateSettings("agent-presets", [{ op: "set", path: ["default"], value: id }]);
      await this.loadAgentPresets();
    } catch (e) {
      this.set({ error: `设置默认 Agent 模式失败: ${String(e)}` });
    }
  }

  async copyAgentPreset(from: string, id: string, name?: string): Promise<void> {
    const api = this.requireApi();
    const r = await api.agentPresets.copy({ from, agentPreset: id, name: name?.trim() || undefined });
    if (!r.result.ok) {
      this.set({ error: `复制 Agent 模式失败: ${r.result.error.code}: ${r.result.error.message}` });
      return;
    }
    await this.loadAgentPresets();
  }

  async removeAgentPreset(id: string): Promise<void> {
    const api = this.requireApi();
    const r = await api.agentPresets.remove({ agentPreset: id });
    if (!r.result.ok) {
      this.set({ error: `删除 Agent 模式失败: ${r.result.error.code}: ${r.result.error.message}` });
      return;
    }
    await this.loadAgentPresets();
  }

  async readAgentPreset(id: string): Promise<{ content: string; name?: string; description?: string } | null> {
    const api = this.requireApi();
    const r = await api.agentPresets.read({ agentPreset: id });
    if (!r.result.ok) {
      this.set({ error: `读取组装失败: ${r.result.error.code}: ${r.result.error.message}` });
      return null;
    }
    return { content: r.result.value.content, name: r.result.value.name, description: r.result.value.description };
  }

  async openAgentPresetDocument(id: string): Promise<void> {
    const api = this.requireApi();
    try {
      const r = await api.agentPresets.openDocument({ agentPreset: id });
      if (r.result.ok) {
        if (!r.result.value.opened) {
          this.set({ error: `已打开预设目录（路径见设置页提示）: ${r.result.value.path}` });
        }
      } else {
        this.set({ error: `打开预设文件失败: ${r.result.error.code}: ${r.result.error.message}` });
      }
    } catch (e) {
      this.set({ error: `打开预设文件失败: ${String(e)}` });
    }
  }

  togglePinned(sessionId: SessionId): void {
    const list = this.state.pinnedSessions.includes(sessionId)
      ? this.state.pinnedSessions.filter((id) => id !== sessionId)
      : [...this.state.pinnedSessions, sessionId];
    try {
      window.localStorage.setItem("pinnedSessions", JSON.stringify(list));
    } catch {
      // ignore storage failures
    }
    this.set({ pinnedSessions: list });
  }

  async archiveSession(sessionId: SessionId): Promise<void> {
    const api = this.requireApi();
    const r = await api.workspace.archiveSession({ sessionId });
    if (!r.result.ok) {
      this.set({ error: `归档会话失败: ${r.result.error.code}: ${r.result.error.message}` });
      return;
    }
    if (this.state.pinnedSessions.includes(sessionId)) {
      this.togglePinned(sessionId);
    }
    this.set({ archivedSessionIds: r.result.value.archivedSessionIds });
    await this.refreshSessions();
  }

  selectSession(sessionId: SessionId | null): void {
    this.set({ selectedSessionId: sessionId });
    if (sessionId && this.state.api) {
      void this.loadHistory(sessionId).catch((e) => this.set({ error: `历史加载失败: ${String(e)}` }));
    }
    // api 未就绪时由 connect() 在连接成功后加载
  }

  setNotice(notice: string | null): void {
    this.set({ notice });
  }

  setError(error: string | null): void {
    this.set({ error });
  }
}

export const appStore = new AppStore();

export function useAppState(): AppState {
  return useSyncExternalStore(appStore.subscribe, appStore.get);
}


/** 从 schemastery schema JSON 中提取 `permission` 命名空间 defaultPreset 的枚举值。 */
function permissionSchemaEnums(schema: unknown): string[] {
  const s = schema as { uid?: number; refs?: Record<string, { type?: string; value?: string; list?: number[]; dict?: Record<string, number> }> } | undefined;
  if (!s || typeof s.uid !== "number" || !s.refs) return [];
  const refs = s.refs;
  const root = refs[String(s.uid)];
  const fieldRef = root?.dict?.defaultPreset;
  if (fieldRef === undefined) return [];
  const field = refs[String(fieldRef)];
  if (field?.type === "union") {
    return (field.list ?? [])
      .map((r) => refs[String(r)]?.value)
      .filter((v): v is string => typeof v === "string");
  }
  if (field?.type === "const" && typeof field.value === "string") return [field.value];
  return [];
}

