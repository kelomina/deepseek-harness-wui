import { useSyncExternalStore } from "react";
import { dsh, onDshLog, onDshStatus, type DshConfig, type DshStatus } from "../tauri";
import { DshApiClient } from "./client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  ApprovalResponsePayload,
  HostFrame,
  MuxFrame,
  QuestionResponsePayload,
  RpcId,
  SessionSummary,
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

  get(): AppState {
    return this.state;
  }

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
    this.set({ status, config });
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

  async createSession(workspaceId?: WorkspaceId): Promise<void> {
    const api = this.requireApi();
    const r = await api.sessions.create({ workspaceId });
    if (r.result.ok) {
      this.set({ selectedSessionId: r.result.value.sessionId });
      await this.refreshSessions();
    } else {
      this.set({ error: `创建会话失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
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

  async addWorkspace(path: string): Promise<void> {
    const api = this.requireApi();
    const r = await api.workspace.create({ path });
    if (!r.result.ok) {
      this.set({ error: `添加工作区失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
    await this.refreshWorkspaces();
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

