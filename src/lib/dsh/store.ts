import { useSyncExternalStore } from "react";
import { dsh, onDshLog, onDshStatus, type DshConfig, type DshStatus } from "../tauri";
import { DshApiClient } from "./client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  ApprovalResponsePayload,
  ConfigurableProviderView,
  CredentialView,
  HostFrame,
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

export interface AppState {
  status: DshStatus | null;
  config: DshConfig | null;
  logs: string[];
  api: DshApiClient | null;
  connected: boolean;
  host: HostDescription | null;
  workspaces: WorkspaceView[];
  sessions: SessionSummary[];
  interactives: InteractiveItem[];
  live: Map<SessionId, MuxFrame[]>;
  selectedSessionId: SessionId | null;
  activeWorkspaceId: WorkspaceId | null;
  hiddenPresets: string[];
  history: Map<SessionId, unknown[]>;
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
  interactives: [],
  live: new Map(),
  selectedSessionId: null,
  activeWorkspaceId: null,
  hiddenPresets: [],
  history: new Map(),
  loading: false,
  error: null,
};

class AppStore {
  private state: AppState = initialState;
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private unlisteners: Array<() => void> = [];
  private started = false;

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
    try {
      hiddenPresets = JSON.parse(window.localStorage.getItem("hiddenPresets") ?? "[]") as string[];
    } catch {
      hiddenPresets = [];
    }
    this.set({ status, config, hiddenPresets });
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
      if (ws.result.ok) this.set({ workspaces: ws.result.value.items });
      const sess = await api.sessions.list({});
      if (sess.result.ok) this.set({ sessions: sess.result.value.items });
      this.set({ connected: true });
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
        this.set({ live });
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

  private dispatchHost(envelope: { rpcId: RpcId; payload: unknown }): void {
    const frame = envelope.payload as HostFrame;
    switch (frame.type) {
      case "host/session-added":
      case "host/session-removed":
      case "host/session-status":
      case "host/archived-sessions-changed":
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

  private requireApi(): DshApiClient {
    if (!this.state.api) throw new Error("dsh 未连接");
    return this.state.api;
  }

  async refreshSessions(): Promise<void> {
    if (!this.state.api) return;
    const r = await this.state.api.sessions.list({});
    if (r.result.ok) this.set({ sessions: r.result.value.items });
  }

  async refreshWorkspaces(): Promise<void> {
    if (!this.state.api) return;
    const r = await this.state.api.workspace.list({});
    if (r.result.ok) this.set({ workspaces: r.result.value.items });
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
    }
  }

  async cancelSession(sessionId: SessionId): Promise<void> {
    const api = this.requireApi();
    const r = await api.sessions.cancel({ sessionId });
    if (!r.result.ok) {
      this.set({ error: `取消失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
  }

  async loadHistory(sessionId: SessionId): Promise<void> {
    const api = this.requireApi();
    const r = await api.sessions.history({ sessionId, maxMessages: 200 });
    if (r.result.ok) {
      const history = new Map(this.state.history);
      history.set(sessionId, r.result.value.events);
      this.set({ history });
    }
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

  selectSession(sessionId: SessionId | null): void {
    this.set({ selectedSessionId: sessionId });
    if (sessionId) void this.loadHistory(sessionId);
  }

  setError(error: string | null): void {
    this.set({ error });
  }
}

export const appStore = new AppStore();

export function useAppState(): AppState {
  return useSyncExternalStore(appStore.subscribe, appStore.get);
}






