import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { dsh, onDshLog, onDshStatus, type DshConfig, type DshStatus } from "../tauri";
import { logger } from "../logger";
import { DshApiClient } from "./client";
import { computeRevertInfo, type RevertInfo } from "./revert";
import { sessionTitle } from "./sessionTitle";
import { decideApproval } from "../policy";
import {
  APPROVAL_TIMEOUT_SECS,
  AUTO_REVIEW_TIMEOUT_SECS,
  DISPATCH_TIMEOUT_SECS,
  type AutoReviewRuling,
  type DispatchDraftCard,
  type DispatchModelSetting,
  type MatchedDispatchCard,
  addTaskCard,
  buildAutoReviewPrompt,
  buildDispatchDecomposePrompt,
  buildDispatchTaskPrompt,
  buildTitlePrompt,
  ceilingForSession,
  employeeBySession,
  fileClassForTool,
  getRoleTemplate,
  isAutoReviewEnabled,
  isAutoReviewValue,
  listTaskCards,
  loadEmployees,
  markHumanDecided,
  matchDispatchCards,
  noteApprovalArrival,
  noteFork,
  normalizePermissionValue,
  parseAutoReviewJson,
  parseDispatchCards,
  parseTitleText,
  pushAuditRow,
  redactSecrets,
  setAutoReviewEnabled,
  setTaskStatus,
} from "../team";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  AgentPresetEntry,
  ApprovalResponsePayload,
  ConfigurableProviderView,
  CredentialView,
  DiscoveredModelView,
  GoalRef,
  HistoryEntry,
  HostFrame,
  JobView,
  ModelProviderGroup,
  MuxFrame,
  PromptContentPart,
  QueuedInboxItem,
  QuestionResponsePayload,
  RpcId,
  SessionSearchItem,
  SessionSummary,
  SettingsNamespaceView,
  SettingsPathOpView,
  SkillEntry,
  SubagentCatalog,
  WorkspaceId,
  WorkspaceView,
} from "@deepseek-ai/dsh-host-apiproxy/api";

/** PRD-004 v1.1：自动审核串行一申请一调用（禁 SQUAD 扇出调用），链式排队。 */
let autoReviewChain: Promise<void> = Promise.resolve();
/** 任务#15+#14：取名串行一会话一调用（禁扇出），链式排队；pending 去重防并发重取。 */
let titleChain: Promise<void> = Promise.resolve();
const pendingTitles = new Set<string>();
/** PRD-dispatch S1：拆解串行一拆解一调用（独立于 autoReviewChain，防抢占二判链），链式排队。 */
let dispatchChain: Promise<void> = Promise.resolve();

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

/** 17:30Z HANDOVER：session/page 返回 records（非 value.events），过滤 type=event 取 .event（view 已无，chunks 为在-flight 分片）。 */
function pageRecordsToHistoryEntries(records: unknown): Array<{ event: unknown }> {
  const arr = Array.isArray(records) ? (records as Array<Record<string, unknown>>) : [];
  const out: Array<{ event: unknown }> = [];
  for (const rec of arr) {
    if (rec && typeof rec === "object" && (rec as { type?: unknown }).type === "event" && "event" in rec) {
      out.push({ event: (rec as { event: unknown }).event });
    }
  }
  return out;
}

function assistantTextFromPageRecords(records: unknown): string {
  return assistantTextFromEvents(pageRecordsToHistoryEntries(records) as unknown[]);
}

/** 17:30Z page 错误 hint（重试/退避沿用 connect 语义：仅 401/403/502 退避；404/信封错直给指引）。 */
function pageErrorHint(msg: string): string {
  if (msg.includes("HTTP 401")) return "（dsh 401：代理已透传上游详情至 Rust 日志，或尝试设置页“重启 dsh”）";
  if (msg.includes("HTTP 403")) return "（dsh 403 围栏：确保经 Rust 代理访问，勿直连 dsh 端口）";
  if (msg.includes("HTTP 502")) return "（dsh 502：服务 starting 或不可用，600/1200/2000ms 退避后重试）";
  if (msg.includes("HTTP 404")) return "（dsh 404：旧 session/history 已移除（未 claim），现用 session/page；确认运行时为 0.1.2-rc.1 且经 Rust 代理）";
  if (msg.includes('missing "request"') || (msg.includes("missing") && msg.includes("request")) || msg.includes("arguments-invalid"))
    return "（信封形状错：session/page 的 args 缺 request 键；最小合法 payload.args={\"request\":{\"address\":{\"kind\":\"session\",\"sessionId\":\"<sid>\"},\"throughSeq\":<cursor/-1>,\"maxMessages\":50}}，wire 键 request 非 _request）";
  if (msg.includes("bad-request") || (msg.includes("throughSeq") && msg.includes("cursor")))
    return "（游标错：throughSeq 须≤snapshot.cursor（空日志-1），超 cursor 即 gateway/bad-request；本轮 throughSeq 取自 session/list 行投影 asOfSeq，缺失时先 refresh 后按 -1 探活）";
  if (msg.includes("signature-invalid") || msg.includes("session/follow") || msg.includes("session/control"))
    return "（stream 误调：follow/control 禁 callUnary 直调（须走 connection.rpc.open，物理疑 /api/remote.mux），误调即 signature-invalid；历史冷读走 session/page）";
  return "";
}

function assistantTextFromEvents(events: unknown[]): string {
  const texts: string[] = [];
  for (const e of events as Array<{
    event?: { type?: string; data?: { message?: { content?: unknown }; content?: unknown } };
  }>) {
    const t = e?.event?.type;
    if (t !== "assistant/message") continue;
    const data = e?.event?.data as { message?: { content?: unknown }; content?: unknown } | undefined;
    const content = data?.message?.content ?? data?.content;
    if (typeof content === "string") {
      if (content.trim()) texts.push(content);
    } else if (Array.isArray(content)) {
      const s = content
        .map((b) =>
          b && typeof b === "object" && (b as { type?: string }).type === "text"
            ? String((b as { text?: unknown }).text ?? "")
            : "",
        )
        .join("");
      if (s.trim()) texts.push(s);
    }
  }
  return texts.join("\n").trim();
}

export interface HostDescription {
  version: string;
  cwd: string;
  /** dsh 0.1.1-rc.2 新增：宿主账号主目录（Web 显示缩写）。 */
  home?: string;
  provider?: string;
  model?: string;
  attachedSessions: number;
  canOpenPath: boolean;
}

/** 全局默认模型（settings 命名空间 agent-default-model；dsh 0.1.1-rc.2 新增，新会话生效）。 */
export interface DefaultModelView {
  value: { provider: string; model: string; reasoningEffort?: string } | null;
  revision: number;
  applies: "live" | "restart";
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

/** PRD-dispatch S3 确认态（store 持有，TeamBoard/WorkSessionView 同源渲染确认卡 modal z200 wide680）。 */
export interface PendingDispatch {
  id: string;
  requirement: string;
  sourceSessionId: SessionId | null;
  cards: MatchedDispatchCard[];
  directCardIds: string[];
  dispatchModelId: string;
  createdAt: number;
}

/** PRD-dispatch Q2 拆解模型视图（同 agent-default-model ns 平行 dispatchModel，一次 CAS；null=未加载）。 */
export interface DispatchModelView {
  setting: DispatchModelSetting | null;
  revision: number;
  applies: "live" | "restart";
}

export interface AppState {
  status: DshStatus | null;
  config: DshConfig | null;
  logs: string[];
  api: DshApiClient | null;
  connected: boolean;
  /** 网关可达：首包 session/list 业务 ok 置 true；仅 connect 失败/disconnect 清 false（事件流中断不清）。 */
  gatewayUp: boolean;
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
  /** 全局默认模型（agent-default-model 命名空间；null=命名空间不存在或未加载）。 */
  defaultModel: DefaultModelView | null;
  /** PRD-004 v1.1 自动审核模型（同 agent-default-model ns 平行 autoReview 字段；value null=容忍关闭）。 */
  autoReviewModel: DefaultModelView | null;
  /** 任务#15+#14 标题取名模型（同 agent-default-model ns 平行 titleModel 字段；value null=不自动取名，零打扰）。 */
  titleModel: DefaultModelView | null;
  /** PRD-dispatch Q2 拆解模型（同 ns 平行 dispatchModel；setting null=跟随默认；mode 默认 follow-default）。 */
  dispatchModel: DispatchModelView | null;
  /** PRD-dispatch S3 待确认分派单（null=无待确认；确认后才 claimClientTaskId 幂等领取）。 */
  pendingDispatch: PendingDispatch | null;
  /** PRD-dispatch S1 拆解中（串行一拆解一调用，禁扇出）。 */
  dispatchBusy: boolean;
  history: Map<SessionId, unknown[]>;
  streams: Map<SessionId, LiveStream>;
  archivedSessionIds: SessionId[];
  agentPresets: AgentPresetEntry[] | null;
  agentPresetsMeta: AgentPresetMeta | null;
  /** agentPresets/list 独立错误（与“未连接”区分，设置页重试用）。 */
  agentPresetsError: string | null;
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
  /** 会话内容搜索结果（session.search；null 表示无搜索）。 */
  searchResults: { items: SessionSearchItem[]; hasMore: boolean } | null;
  /** 搜索索引被部署禁用（dsh web profile 默认 openAt=never）时的提示态。 */
  searchDisabled: boolean;
  searching: boolean;
  /** 每会话待处理消息队列快照（session/queue 帧 + updateQueue 配对）。 */
  sessionQueues: Map<SessionId, QueuedInboxItem[]>;
  /** 每会话后台任务快照（session/jobs 帧）。 */
  sessionJobs: Map<SessionId, JobView[]>;
  /** 每会话投影值存储（higher-seq-wins；goal/title/permissions/imageLimits 等）。 */
  projections: Map<SessionId, Record<string, { seq: number; value: unknown }>>;
  /** mux 订阅基线 lastSeq（用于丢弃早于基线的投影帧）。 */
  subscribedSeqs: Record<SessionId, number>;
  /** 子代理目录（subagent.list；key=父会话）。 */
  subagentCatalogs: Map<SessionId, SubagentCatalog>;
  /** 子代理历史（subagent.history；key=子会话）。 */
  subagentHistories: Map<SessionId, HistoryEntry[]>;
  /** 技能目录（skill.list；随会话项目变化）。 */
  skills: SkillEntry[] | null;
  /** skill.list 因会话未 attach（session-not-found）不可用时的提示态。 */
  skillsUnavailable: boolean;
  /** 待插入输入框的技能名（会话功能坞「技能」子tab 点击技能后置位；消费后置 null）。 */
  pendingSkillInsert: string | null;
  loading: boolean;
  error: string | null;
}

const initialState: AppState = {
  status: null,
  config: null,
  logs: [],
  api: null,
  connected: false,
  gatewayUp: false,
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
  defaultModel: null,
  autoReviewModel: null,
  titleModel: null,
  dispatchModel: null,
  pendingDispatch: null,
  dispatchBusy: false,
  history: new Map(),
  streams: new Map(),
  archivedSessionIds: [],
  agentPresets: null,
  agentPresetsMeta: null,
  agentPresetsError: null,
  pendingAgentPreset: null,
  sessionPermissions: new Map(),
  sessionModels: new Map(),
  stoppingSessions: {},
  forceFinished: [],
  stopEvidence: {},
  notice: null,
  searchResults: null,
  searchDisabled: false,
  searching: false,
  sessionQueues: new Map(),
  sessionJobs: new Map(),
  projections: new Map(),
  subscribedSeqs: {},
  subagentCatalogs: new Map(),
  subagentHistories: new Map(),
  skills: null,
  skillsUnavailable: false,
  pendingSkillInsert: null,
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
    if (partial.error) {
      logger.error("ui", partial.error);
    }
    if (partial.notice) {
      logger.info("ui", partial.notice);
    }
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((fn) => fn());
  }

  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    logger.initSubscriptions();
    logger.info("system", "应用状态初始化中...");
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
    this.set({ api, connected: false, gatewayUp: false, error: null });
    // 0.1.2-rc.1 Typert 网关：host 命名空间已移除（host.describe→404），首包改用
    // session/list 探活（slash + {args:{_request:{}}} 由 client.ts 垫片翻译；仍经 Rust 代理，
    // BrowserAuth cookie 由代理注入）。Starting 窗口 401 仍指数退避重试；404 为
    // 确定性版本错位，不重试直给指引；missing _request 归信封形状错（15:30Z）。
    const maxAttempts = 3;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (abort.signal.aborted) break;
      try {
        const sess = await api.sessions.list({});
        if (!sess.result.ok) throw new Error(`session/list 业务失败: ${sess.result.error.code}: ${sess.result.error.message}`);
        this.set({ sessions: sess.result.value.items, sessionTitles: this.seedSessionTitles(sess.result.value.items) });
        // host.describe 已移除：置 null（UI 均为 nullable-safe，回退到 session.cwd）。
        this.set({ host: null });
        // 15:00Z HANDOVER: workspace.list 新网关无等价方法，不硬凑：会话名单走 session/list（已有），工作区行暂空（follow 另单）。
        // connect 内 best-effort 置空，不抛错，不发请求。
        this.set({ workspaces: [] });
        void this.loadAgentPresets();
        void this.loadDefaultModel();
        this.set({ connected: true, gatewayUp: true, agentPresetsError: null });
        void this.loadModels();
        if (this.state.selectedSessionId) {
          void this.loadHistory(this.state.selectedSessionId).catch((e) => this.set({ error: `历史加载失败: ${String(e)}` }));
        }
        void this.pump(api.events.mux({}, abort.signal), "mux");
        void this.pump(api.events.host({}, abort.signal), "host");
        return;
      } catch (e) {
        lastError = e;
        const msg = String(e);
        const isNotFound = msg.includes("HTTP 404");
        const isTransport = !isNotFound && (msg.includes("transport failure") || msg.includes("HTTP 401") || msg.includes("HTTP 403") || msg.includes("HTTP 502"));
        if (abort.signal.aborted) break;
        if (isTransport && attempt < maxAttempts) {
          const delay = attempt === 1 ? 600 : attempt === 2 ? 1200 : 2000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        const hint = msg.includes("HTTP 401")
          ? `（dsh 返回 401：代理已透传上游 401 详情至 Rust 日志；请在设置页查看“代理端口 ${proxyPort} / dsh 端口 ${this.state.status?.port ?? "?"}”并检查 %USERPROFILE%\\.dsh\\logs\\harness.log 尾部，或尝试设置页“重启 dsh”）`
          : msg.includes("HTTP 403")
            ? `（dsh 403 围栏：确保经 Rust 代理访问，勿直连 dsh 端口；代理 ${proxyPort}→dsh ${this.state.status?.port ?? "?"}}）`
            : (msg.includes('missing "_request"') || (msg.includes("missing") && msg.includes("_request")) || msg.includes("arguments-invalid"))
              ? `（信封形状错：session/list 的 args 缺 _request 键（网关 assertExactArguments）；最小合法信封 payload.args={"_request":{}}（cursor 可选），前端垫片已补，仍报错请抓包核对 wire；仍经 Rust 代理，勿直连 dsh 端口）`
              : isNotFound
              ? `（dsh 返回 404 not found：方法不存在/版本错位；前端已切 slash + {args}（0.1.2-rc.1 Typert 网关），首包现用 session/list 探活（host.describe 已移除）；请确认运行时为 0.1.2-rc.1 且经 Rust 代理访问（代理 ${proxyPort}→dsh ${this.state.status?.port ?? "?"}），勿直连 dsh 端口）`
              : "";
        this.set({ error: `连接失败: ${msg}${hint}`, connected: false, gatewayUp: false, api: null });
        // 同步写前端内存环形日志，便于 LogPanel 导出复查（BUG-13 已定性仅内存，此处补一句落盘提示由用户手动导出）
        try {
          const { logger } = await import("../logger");
          logger.error("ui", `connect 失败（attempt ${attempt}/${maxAttempts}）：${msg}${hint}`, e);
        } catch {
          // ignore logger import failure
        }
        return;
      }
    }
    // 理论不可达：循环内已 return；兜底
    if (lastError !== null) {
      this.set({ error: `连接失败: ${String(lastError)}`, connected: false, gatewayUp: false, api: null });
    }
  }

  private disconnect(): void {
    this.abort?.abort();
    this.abort = null;
    this.set({
      api: null,
      connected: false,
      gatewayUp: false,
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
      defaultModel: null,
      autoReviewModel: null,
      titleModel: null,
      dispatchModel: null,
      pendingDispatch: null,
      dispatchBusy: false,
      searchResults: null,
      searchDisabled: false,
      searching: false,
      sessionQueues: new Map(),
      sessionJobs: new Map(),
      projections: new Map(),
      subscribedSeqs: {},
      subagentCatalogs: new Map(),
      subagentHistories: new Map(),
      skills: null,
      skillsUnavailable: false,
      pendingSkillInsert: null,
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
      // 事件流结束不清 connected/gatewayUp：单路 WS 中断≠网关不可达（unary 仍可用）；
      // 真停机由 status 轮询 syncConnection→disconnect 清理，避免会话正常时设置页误报“未连接”。
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
      case "approval/requested": {
        // PRD-003 v1.1 域②拦截器 + PRD-004 v1.1 FR-M203 裁决管线：
        // deny 先行（不进模型）→ ask灰带/allow复核进模型二判（隔离会话降级）→ fail-closed 转人工。
        // 仅 autoReview.enabled 才进二判，否则走 PRD-003 原三判；question 仍不进管线。
        const req = frame as unknown as { sessionId: SessionId; approvalId: string; toolName?: string; reason?: string };
        const sess = this.state.sessions.find((s) => s.sessionId === req.sessionId);
        const ceiling = ceilingForSession(req.sessionId);
        const decision = decideApproval({
          toolName: req.toolName ?? "unknown",
          reason: req.reason,
          workspaceRoot: sess?.cwd ?? this.state.host?.cwd ?? null,
          ceiling,
          preset: this.state.sessionPermissions.get(req.sessionId)?.currentValue ?? null,
          canOpenPath: this.state.host?.canOpenPath ?? false,
          unattended: false,
        });
        const redacted = redactSecrets(req.reason ?? "");
        noteApprovalArrival(String(req.approvalId));
        const autoReviewOn = isAutoReviewEnabled();
        // deny 先行：任何模式不进模型，直接拒绝（FR-M203 第一段）。
        if (decision.verdict === "deny") {
          const autoItem: InteractiveItem = { rpcId: envelope.rpcId, kind: "approval", sessionId: req.sessionId, frame };
          pushAuditRow({
            requestId: String(req.approvalId),
            source: "dsh-approval",
            verdict: "auto-deny",
            policyRowId: decision.rowId,
            ceiling,
            decidedAt: Date.now(),
            evidence: { sessionId: req.sessionId, rpcId: String(envelope.rpcId) },
            reasonRedacted: redacted,
            reviewVerdict: "deny-auto",
            pipelineMs: 0,
          });
          void this.answerApproval(autoItem, "rejected", { auto: true }).catch((e) =>
            this.set({ error: `自动审核应答失败: ${String(e)}` }),
          );
          this.set({ notice: `已自动拒绝 ${req.toolName ?? ""}（${decision.rowId}）` });
          break;
        }
        // 非 auto-review：沿 PRD-003 原三判（allow 自动批，其余转人工）。
        if (!autoReviewOn) {
          if (decision.verdict === "allow") {
            const autoItem: InteractiveItem = { rpcId: envelope.rpcId, kind: "approval", sessionId: req.sessionId, frame };
            pushAuditRow({
              requestId: String(req.approvalId),
              source: "dsh-approval",
              verdict: "auto-allow",
              policyRowId: decision.rowId,
              ceiling,
              decidedAt: Date.now(),
              evidence: { sessionId: req.sessionId, rpcId: String(envelope.rpcId) },
              reasonRedacted: redacted,
            });
            void this.answerApproval(autoItem, "allowed-once", { auto: true }).catch((e) =>
              this.set({ error: `自动审核应答失败: ${String(e)}` }),
            );
            this.set({ notice: `已自动批准 ${req.toolName ?? ""}（${decision.rowId}）` });
            break;
          }
          this.enterHumanApproval(req, frame, envelope, decision, ceiling, redacted, null);
          break;
        }
        // auto-review 二判：ask 灰带 + allow 复核进模型；未配置模型即降级人工（禁静默顶替）。
        const autoVal = this.state.autoReviewModel?.value ?? null;
        if (!autoVal || !autoVal.provider || !autoVal.model) {
          this.enterHumanApproval(req, frame, envelope, decision, ceiling, redacted, {
            reviewVerdict: "manual",
            reviewReason: "未配置审核模型，已降级人工",
          });
          this.set({ notice: "未配置审核模型，已降级人工" });
          break;
        }
        // Windows 边界双查已在 decideApproval 覆盖（deny 先行不浪费模型调用）。
        const toolName = req.toolName ?? "unknown";
        const workspaceRoot = sess?.cwd ?? this.state.host?.cwd ?? null;
        const owner = employeeBySession(loadEmployees(), String(req.sessionId));
        const prompt = buildAutoReviewPrompt({
          tool: toolName,
          scope: workspaceRoot ? "工作区内" : "未知",
          fileClass: fileClassForTool(toolName),
          policyRowId: decision.rowId,
          ceiling,
          role: owner ? `${owner.name}(${owner.role})` : "unassigned",
          reasonSnippet: req.reason ?? "",
        });
        const modelId = `${autoVal.provider}/${autoVal.model}`;
        const started = Date.now();
        this.set({ notice: `自动审核中 ${toolName}（${modelId}）…` });
        void this.runAutoReviewSecondPass(prompt, autoVal).then((res) => {
          const pipelineMs = Date.now() - started;
          if (!res || !res.ruling) {
            // abstain/超时60s/空回合/错误一律转人工（fail-closed，不自动批）。
            this.enterHumanApproval(req, frame, envelope, decision, ceiling, redacted, {
              reviewVerdict: res?.abstain ? "abstain" : "manual",
              reviewModelId: modelId,
              reviewLatencyMs: res?.latencyMs,
              reviewTokens: "unknown",
              reviewReason: res?.abstain ? res.rulingReason ?? "abstain，转人工" : "二判失败，已转人工",
              pipelineMs,
            });
            return;
          }
          const { ruling, latencyMs } = res;
          const reasonClean = redactSecrets(ruling.reason ?? "").slice(0, 200);
          if (ruling.verdict === "allow") {
            const autoItem: InteractiveItem = { rpcId: envelope.rpcId, kind: "approval", sessionId: req.sessionId, frame };
            pushAuditRow({
              requestId: String(req.approvalId),
              source: "dsh-approval",
              verdict: "auto-allow",
              policyRowId: decision.rowId,
              ceiling,
              decidedAt: Date.now(),
              evidence: { sessionId: req.sessionId, rpcId: String(envelope.rpcId) },
              reasonRedacted: redacted,
              reviewVerdict: "allow",
              reviewModelId: modelId,
              reviewLatencyMs: latencyMs,
              reviewTokens: "unknown",
              reviewReason: reasonClean,
              reviewRisk: ruling.risk,
              pipelineMs,
            });
            void this.answerApproval(autoItem, "allowed-once", { auto: true }).catch((e) =>
              this.set({ error: `自动审核应答失败: ${String(e)}` }),
            );
            this.set({ notice: `自动审核已批准 ${toolName}（${modelId}）` });
          } else if (ruling.verdict === "reject") {
            const autoItem: InteractiveItem = { rpcId: envelope.rpcId, kind: "approval", sessionId: req.sessionId, frame };
            pushAuditRow({
              requestId: String(req.approvalId),
              source: "dsh-approval",
              verdict: "auto-deny",
              policyRowId: decision.rowId,
              ceiling,
              decidedAt: Date.now(),
              evidence: { sessionId: req.sessionId, rpcId: String(envelope.rpcId) },
              reasonRedacted: redacted,
              reviewVerdict: "reject",
              reviewModelId: modelId,
              reviewLatencyMs: latencyMs,
              reviewTokens: "unknown",
              reviewReason: reasonClean,
              reviewRisk: ruling.risk,
              pipelineMs,
            });
            void this.answerApproval(autoItem, "rejected", { auto: true }).catch((e) =>
              this.set({ error: `自动审核应答失败: ${String(e)}` }),
            );
            this.set({ notice: `自动审核已拒绝 ${toolName}（${modelId}）` });
          } else {
            this.enterHumanApproval(req, frame, envelope, decision, ceiling, redacted, {
              reviewVerdict: "abstain",
              reviewModelId: modelId,
              reviewLatencyMs: latencyMs,
              reviewTokens: "unknown",
              reviewReason: reasonClean,
              reviewRisk: ruling.risk,
              pipelineMs,
            });
          }
        });
        break;
      }
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
      case "session/queue": {
        // 队列全量快照：覆盖式更新（帧本身即权威信号）
        const q = new Map(this.state.sessionQueues);
        q.set(frame.sessionId, frame.items);
        this.set({ sessionQueues: q });
        break;
      }
      case "session/jobs": {
        const j = new Map(this.state.sessionJobs);
        j.set(frame.sessionId, frame.jobs);
        this.set({ sessionJobs: j });
        break;
      }
      case "session/projection":
        this.applyProjection(frame.sessionId, frame.key, frame.value, frame.seq);
        break;
      case "session/subscribed": {
        // 订阅基线：记录 lastSeq，用于丢弃早于基线的投影帧
        this.set({ subscribedSeqs: { ...this.state.subscribedSeqs, [frame.sessionId]: frame.lastSeq } });
        break;
      }
      case "stream/error":
        this.set({ error: `事件流错误: ${frame.error.code}: ${frame.error.message}` });
        break;
      default:
        break;
    }
  }

  /** 投影存储（higher-seq-wins）：同 key 仅接受更高 seq 的值；title 投影同步本地标题表。 */
  private applyProjection(sessionId: SessionId, key: string, value: unknown, seq: number): void {
    const perSession = this.state.projections.get(sessionId) ?? {};
    const cur = perSession[key];
    if (cur && cur.seq > seq) return;
    const next = { ...perSession, [key]: { seq, value } };
    const m = new Map(this.state.projections);
    m.set(sessionId, next);
    this.set({ projections: m });
    if (key === "title" && typeof value === "string" && value) {
      this.set({ sessionTitles: { ...this.state.sessionTitles, [sessionId]: value } });
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
      case "host/remote-event":
        // 宿主转发的 allowlist cordis 事件：进日志留痕（无 UI 语义）
        this.set({ logs: [...this.state.logs.slice(-499), `[host-event] ${frame.event}`] });
        break;
      case "stream/error":
        this.set({ error: `宿主事件流错误: ${frame.error.code}: ${frame.error.message}` });
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
    // 15:00Z HANDOVER: workspace.list 无等价方法，不硬凑：降级为空列表 best-effort，不抛错，不发请求；归档集走 archiveSession 返回值 + 事件帧，工作区行暂空（follow 另单）。
    this.set({ workspaces: [] });
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
          await api.agentPresetsSelect({ agentId: id, agentPreset: preset });
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

  /** 发送消息（可携带图片附件；text 与 images 至少其一非空）。 */
  async sendPrompt(sessionId: SessionId, text: string, images: Array<{ mediaType: string; data: string; name?: string }> = []): Promise<void> {
    const api = this.requireApi();
    const content: PromptContentPart[] = [];
    if (text.trim()) content.push({ type: "text", text });
    for (const img of images) {
      content.push({ type: "image", mediaType: img.mediaType as never, data: img.data, name: img.name });
    }
    if (content.length === 0) return;
    const r = await api.sessions.prompt({
      sessionId,
      mode: "queue",
      content,
    });
    if (!r.result.ok) {
      this.set({ error: `发送失败: ${r.result.error.code}: ${r.result.error.message}` });
      return;
    }
    // 任务#15+#14：首条文本触发自动取名（未配置=零打扰；已有标题跳过；fire-and-forget）。
    if (text.trim()) {
      try {
        this.autoTitleSession(sessionId, text);
      } catch {
        // 零打扰
      }
    }
    window.setTimeout(() => {
      void this.loadHistory(sessionId).catch(() => {});
    }, 1500);
  }

  /** 读取会话引用的持久化图片（session.attachment）。 */
  async getAttachment(sessionId: SessionId, attachmentId: string): Promise<{ mediaType: string; data: string } | null> {
    const api = this.requireApi();
    const r = await api.sessions.attachment({ sessionId, attachmentId: attachmentId as never });
    if (!r.result.ok) {
      this.set({ error: `读取附件失败: ${r.result.error.code}: ${r.result.error.message}` });
      return null;
    }
    const v = r.result.value as { attachment: { mediaType: string }; data: string };
    return { mediaType: v.attachment.mediaType, data: v.data };
  }

  /** 会话内容搜索（session.search；结果无游标，hasMore 提示细化查询）。
   * 部署禁用索引时（web profile 默认 openAt=never）进入 searchDisabled 提示态而非错误横幅。 */
  async searchSessions(query: string): Promise<void> {
    const q = query.trim();
    if (!q) {
      this.set({ searchResults: null, searchDisabled: false });
      return;
    }
    const api = this.requireApi();
    this.set({ searching: true });
    try {
      const r = await api.sessions.search({ query: q }, new AbortController().signal);
      if (r.result.ok) {
        this.set({ searchResults: { items: r.result.value.items, hasMore: r.result.value.hasMore }, searchDisabled: false });
      } else if (/search is disabled/.test(r.result.error.message ?? "")) {
        // [事实] dsh 0.1.0-rc.6 web profile 默认 session-query openAt=never；启用需用户层 patch（见 RISKS 2026-08-23）
        this.set({ searchResults: null, searchDisabled: true });
      } else {
        this.set({ searchResults: null, error: `搜索失败: ${r.result.error.code}: ${r.result.error.message}` });
      }
    } catch (e) {
      this.set({ error: `搜索失败: ${String(e)}` });
    } finally {
      this.set({ searching: false });
    }
  }

  clearSearch(): void {
    this.set({ searchResults: null, searchDisabled: false });
  }

  /** 编辑/移除/插队一条待处理消息（session.updateQueue）。 */
  async queueAction(
    sessionId: SessionId,
    itemId: QueuedInboxItem["id"],
    action:
      | { kind: "edit"; text: string }
      | { kind: "remove" }
      | { kind: "steer" },
  ): Promise<void> {
    const api = this.requireApi();
    const wire =
      action.kind === "edit"
        ? { kind: "edit", content: [{ type: "text", text: action.text }] as never }
        : { kind: action.kind };
    const r = await api.sessions.updateQueue({ sessionId, itemId, action: wire as never });
    if (!r.result.ok) {
      this.set({ error: `队列操作失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
    // 成功后由 session/queue 全量快照帧驱动 UI 更新
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


  /** 17:30Z：session/list 行投影 asOfSeq 即 snapshot.cursor（空日志-1），供 page throughSeq 用。 */
  private throughSeqForSession(sessionId: SessionId): number | null {
    const s = this.state.sessions.find((x) => x.sessionId === sessionId) as unknown as
      | { projections?: { asOfSeq?: unknown } }
      | undefined;
    const v = s?.projections?.asOfSeq;
    return typeof v === "number" && Number.isInteger(v) && v >= -1 ? v : null;
  }

  /** 17:30Z：隔离会话（auto-review 二判）轮询读尾：每次先 refresh 取最新 asOfSeq 作 throughSeq 再 page（cursor 随回合增长，仍经代理）。失败返回 null（调用方 continue/转人工，不抛）。 */
  private async isolationAssistantText(api: DshApiClient, isoId: SessionId, maxMessages: number): Promise<string | null> {
    try {
      try {
        await this.refreshSessions();
      } catch {
        // ignore，fallback 用州内旧 cursor/-1
      }
      const throughSeq = this.throughSeqForSession(isoId) ?? -1;
      const r = await (api as unknown as {
        sessionPage: (req: unknown) => Promise<{ result: { ok: boolean; value?: unknown } }>;
      }).sessionPage({ address: { kind: "session", sessionId: isoId as string }, throughSeq, maxMessages });
      if (!r.result.ok) return null;
      const text = assistantTextFromPageRecords((r.result.value as { records?: unknown }).records ?? []);
      return text ? text : null;
    } catch {
      return null;
    }
  }

  /** 17:30Z：旧 sessions.history 已移除→session/page（unary 冷读）；page 无 projections，投影改源 follow snapshot（拿不到先保历史可读，另注）。 */
  async loadHistory(sessionId: SessionId, opts?: { beforeSeq?: number; maxMessages?: number }): Promise<void> {
    const api = this.requireApi();
    const maxMessages = opts?.maxMessages ?? 200;
    const beforeSeq = opts?.beforeSeq;
    let throughSeq = this.throughSeqForSession(sessionId);
    if (throughSeq === null) {
      try {
        await this.refreshSessions();
        throughSeq = this.throughSeqForSession(sessionId);
      } catch {
        // ignore，fallback -1 探活
      }
      if (throughSeq === null) throughSeq = -1;
    }
    let r: { result: { ok: boolean; value?: unknown; error?: { code: string; message: string } } };
    try {
      r = (await (api as unknown as {
        sessionPage: (req: unknown) => Promise<{ result: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }>;
      }).sessionPage({
        address: { kind: "session", sessionId: sessionId as string },
        throughSeq,
        ...(typeof beforeSeq === "number" ? { beforeSeq } : {}),
        maxMessages,
      })) as typeof r;
    } catch (e) {
      const msg = String(e);
      throw new Error(`session/page 失败${pageErrorHint(msg)}: ${msg}`);
    }
    if (r.result.ok) {
      const records = (r.result.value as { records?: unknown }).records ?? [];
      const entries = pageRecordsToHistoryEntries(records);
      const history = new Map(this.state.history);
      history.set(sessionId, entries as unknown[]);
      // page 无 projections：权限/基线播种改源 follow snapshot（stream 载体待后端另单确认代理路径，本轮先保历史可读）。
      this.set({ history });
    } else {
      const err = (r.result as { error: { code: string; message: string } }).error;
      throw new Error(`session/page 业务失败${pageErrorHint(`${err.code}: ${err.message}`)}: ${err.code}: ${err.message}`);
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

  /** PRD-004 FR-M203 第三段 fail-closed：转人工（进 interactives + 红点 + notice + 置顶，不自动批）。 */
  private enterHumanApproval(
    req: { sessionId: SessionId; approvalId: string; toolName?: string },
    frame: MuxFrame,
    envelope: { rpcId: RpcId },
    decision: { rowId: string },
    ceiling: string,
    redacted: string,
    review: {
      reviewVerdict?: "allow" | "reject" | "abstain" | "deny-auto" | "manual";
      reviewModelId?: string;
      reviewLatencyMs?: number;
      reviewTokens?: string;
      reviewReason?: string;
      reviewRisk?: "low" | "med" | "high";
      pipelineMs?: number;
    } | null,
  ): void {
    pushAuditRow({
      requestId: String(req.approvalId),
      source: "dsh-approval",
      verdict: "to-human",
      policyRowId: decision.rowId,
      ceiling,
      decidedAt: Date.now(),
      evidence: { sessionId: req.sessionId, rpcId: String(envelope.rpcId) },
      reasonRedacted: redacted,
      ...(review ?? {}),
    });
    this.set({
      interactives: [
        ...this.state.interactives.filter(
          (i) => !(i.kind === "approval" && i.frame.type === "approval/requested" && (i.frame as unknown as { approvalId: string }).approvalId === (frame as unknown as { approvalId: string }).approvalId),
        ),
        { rpcId: envelope.rpcId, kind: "approval", sessionId: req.sessionId, frame: frame as InteractiveItem["frame"] },
      ],
    });
    window.setTimeout(() => {
      const still = this.state.interactives.find(
        (i) => i.kind === "approval" && i.frame.type === "approval/requested" && (i.frame as unknown as { approvalId: string }).approvalId === req.approvalId,
      );
      if (still) {
        this.set({
          interactives: [still, ...this.state.interactives.filter((i) => i !== still)],
          notice: `申请 ${req.toolName ?? ""} 已等待超过 ${APPROVAL_TIMEOUT_SECS}s，仍为待判并置顶（不自动批）`,
        });
      }
    }, APPROVAL_TIMEOUT_SECS * 1000);
  }

  /**
   * PRD-004 FR-M203 第二段模型二判（降级通道：sendPrompt 新隔离会话一申请一调用）。
   * llm.* 仅 providers/models/discoverModels，无 completion 直调（已确认），故走降级。
   * 输出严格 JSON；abstain/超时60s/空回合/错误一律返回 null（调用方转人工，禁假裁决）。
   */
  private runAutoReviewSecondPass(
    prompt: string,
    model: { provider: string; model: string; reasoningEffort?: string },
  ): Promise<{ ruling: AutoReviewRuling; latencyMs: number } | { ruling: null; abstain: boolean; rulingReason?: string; latencyMs?: number } | null> {
    const task = (async () => {
      const api = this.state.api;
      if (!api) return null;
      const t0 = Date.now();
      try {
        const cr = await api.sessions.create({});
        if (!cr.result.ok) return null;
        const isoId = cr.result.value.sessionId;
        try {
          await api.sessions.selectModel({
            sessionId: isoId,
            provider: model.provider,
            model: model.model,
            reasoningEffort: model.reasoningEffort ?? undefined,
          } as never).catch(() => undefined);
        } catch {
          // 选模型失败不阻断，沿用会话默认（仍须二判，失败则转人工）
        }
        const pr = await api.sessions.prompt({
          sessionId: isoId,
          mode: "queue",
          content: [{ type: "text", text: prompt }],
        } as never);
        if (!pr.result.ok) return null;
        const deadline = t0 + AUTO_REVIEW_TIMEOUT_SECS * 1000;
        let firstBad: string | null = null;
        while (Date.now() < deadline) {
          await sleepMs(2000);
          try {
            // 17:30Z：隔离会话轮询改 session/page（throughSeq 取最新 asOfSeq，records 取 event；仍经代理）。
            const text = await this.isolationAssistantText(api, isoId, 20);
            if (!text) continue;
            const ruling = parseAutoReviewJson(text);
            if (ruling) return { ruling, latencyMs: Date.now() - t0 };
            // JSON 破损：记一次，重试≤1 次仍败转人工（不发第二遍 prompt，只重读一次）。
            if (firstBad === null) {
              firstBad = text;
              await sleepMs(2000);
              try {
                const text2 = await this.isolationAssistantText(api, isoId, 20);
                if (text2) {
                  const ruling2 = parseAutoReviewJson(text2);
                  if (ruling2) return { ruling: ruling2, latencyMs: Date.now() - t0 };
                }
              } catch {
                // ignore, fall through to null
              }
              return { ruling: null, abstain: false, rulingReason: "JSON解析失败，已转人工", latencyMs: Date.now() - t0 };
            }
          } catch {
            return null;
          }
        }
        return null;
      } catch {
        return null;
      }
    })();
    // 串行：链式排队，前一判完成才开始下一判。
    const chained = autoReviewChain.then(() => task);
    autoReviewChain = chained.then(() => undefined).catch(() => undefined);
    return chained;
  }

  /* ---------------- PRD-dispatch S1~S6 全管线（零新增 invoke/事件，仍经代理） ---------------- */

  /** Q2 拆解模型解析：follow-default 跟随默认；specified 未配齐回落默认+显式提示；均无则显式空态。 */
  resolveDispatchModel(): {
    model: { provider: string; model: string; reasoningEffort?: string } | null;
    modelId: string;
    fallbackNotice: string | null;
    empty: string | null;
  } {
    const disp = this.state.dispatchModel?.setting ?? null;
    const def = this.state.defaultModel?.value ?? null;
    const mode = disp?.mode ?? "follow-default";
    if (mode === "specified") {
      if (disp?.provider?.trim() && disp?.model?.trim()) {
        const m: { provider: string; model: string; reasoningEffort?: string } = {
          provider: disp.provider.trim(),
          model: disp.model.trim(),
        };
        if (disp.reasoningEffort?.trim()) m.reasoningEffort = disp.reasoningEffort.trim();
        return { model: m, modelId: `${m.provider}/${m.model}`, fallbackNotice: null, empty: null };
      }
      if (def?.provider && def?.model) {
        const m: { provider: string; model: string; reasoningEffort?: string } = {
          provider: def.provider,
          model: def.model,
        };
        if (def.reasoningEffort) m.reasoningEffort = def.reasoningEffort;
        return {
          model: m,
          modelId: `${m.provider}/${m.model}`,
          fallbackNotice: "拆解模型未配齐，已回落默认模型（请在设置页补齐拆解模型）",
          empty: null,
        };
      }
      return { model: null, modelId: "", fallbackNotice: null, empty: "未配置拆解模型与默认模型（请先在设置页配置默认模型）" };
    }
    if (def?.provider && def?.model) {
      const m: { provider: string; model: string; reasoningEffort?: string } = {
        provider: def.provider,
        model: def.model,
      };
      if (def.reasoningEffort) m.reasoningEffort = def.reasoningEffort;
      return { model: m, modelId: `${m.provider}/${m.model}`, fallbackNotice: null, empty: null };
    }
    return { model: null, modelId: "", fallbackNotice: null, empty: "未配置默认模型（拆解跟随默认，请先在设置页配置）" };
  }

  /**
   * S1 同构隔离链（复用 runAutoReviewSecondPass 结构：create+selectModel+prompt queue+page 轮询≤60s+重试≤1+串行）。
   * 差异仅：独立 dispatchChain（防抢 autoReviewChain）+ cards 严格 JSON 解析；token 记 unknown 不伪造；reason 脱敏 ****。
   */
  private runDispatchDecompose(
    prompt: string,
    model: { provider: string; model: string; reasoningEffort?: string },
  ): Promise<{ cards: DispatchDraftCard[]; latencyMs: number } | { cards: null; reason: string; latencyMs?: number } | null> {
    const task = (async () => {
      const api = this.state.api;
      if (!api) return null;
      const t0 = Date.now();
      try {
        const cr = await api.sessions.create({});
        if (!cr.result.ok) return null;
        const isoId = cr.result.value.sessionId;
        try {
          await api.sessions.selectModel({
            sessionId: isoId,
            provider: model.provider,
            model: model.model,
            reasoningEffort: model.reasoningEffort ?? undefined,
          } as never).catch(() => undefined);
        } catch {
          // 选模型失败不阻断，沿用会话默认（失败则转 S6）。
        }
        const pr = await api.sessions.prompt({
          sessionId: isoId,
          mode: "queue",
          content: [{ type: "text", text: prompt }],
        } as never);
        if (!pr.result.ok) return null;
        const deadline = t0 + DISPATCH_TIMEOUT_SECS * 1000;
        let firstBad: string | null = null;
        while (Date.now() < deadline) {
          await sleepMs(2000);
          try {
            const text = await this.isolationAssistantText(api, isoId, 20);
            if (!text) continue;
            const cards = parseDispatchCards(text);
            if (cards) return { cards, latencyMs: Date.now() - t0 };
            if (firstBad === null) {
              firstBad = text;
              await sleepMs(2000);
              try {
                const text2 = await this.isolationAssistantText(api, isoId, 20);
                if (text2) {
                  const cards2 = parseDispatchCards(text2);
                  if (cards2) return { cards: cards2, latencyMs: Date.now() - t0 };
                }
              } catch {
                // ignore, fall through
              }
              return { cards: null, reason: "拆解输出非严格 JSON，已转回退", latencyMs: Date.now() - t0 };
            }
          } catch {
            return null;
          }
        }
        return { cards: null, reason: "拆解超时（60s），已转回退", latencyMs: Date.now() - t0 };
      } catch {
        return null;
      }
    })();
    const chained = dispatchChain.then(() => task);
    dispatchChain = chained.then(() => undefined).catch(() => undefined);
    return chained;
  }

  /**
   * S0→S3 入口：Work 会话 composer /分派 <需求> 触发（调用方已做 ^/分派 拦截与空参/非 Work 分流）。
   * S1 按 dispatchModel 拆 N 卡严格 JSON → S2 确定性匹配 → S3 待确认（默认确认+可信卡直派）。
   * 失败一律 S6：拆解败→降级直答当前会话（不建分派会话）+保留原文可重拆。
   */
  async startDispatch(requirement: string, sourceSessionId: SessionId | null): Promise<void> {
    const req = (requirement ?? "").trim();
    if (!req) return;
    if (!this.state.api || !this.state.connected) {
      this.set({ error: "dsh 未连接，无法拆解（请先连接后再 /分派）" });
      return;
    }
    if (!this.state.modelGroups) {
      this.set({ error: "模型目录不可用，无法拆解（请先在设置页加载模型目录）" });
      return;
    }
    const resolved = this.resolveDispatchModel();
    if (!resolved.model) {
      this.set({ error: resolved.empty ?? "未配置拆解模型" });
      return;
    }
    if (resolved.fallbackNotice) this.set({ notice: resolved.fallbackNotice });
    if (this.state.dispatchBusy) {
      this.set({ notice: "拆解进行中，请稍候（串行一拆解一调用）" });
      return;
    }
    this.set({ dispatchBusy: true });
    try {
      const employees = loadEmployees();
      const teamHint =
        employees.length > 0
          ? employees.map((e) => `${e.name}(${(getRoleTemplate(e.role)?.name ?? e.role)}${(e.skillSnapshot ?? []).length ? `:${e.skillSnapshot.join(",")}` : ""})`).join("；")
          : "";
      const prompt = buildDispatchDecomposePrompt(req, teamHint);
      const res = await this.runDispatchDecompose(prompt, resolved.model);
      if (!res || !res.cards || res.cards.length === 0) {
        // S6 拆解失败→降级直答当前会话（不建分派会话），原文保留可重拆。
        const reason = res && "reason" in res && res.reason ? res.reason : "拆解失败（坏 JSON/超时/空回合）";
        pushAuditRow({
          requestId: `dispatch-${Date.now().toString(36)}`,
          source: "dsh-approval",
          verdict: "to-human",
          policyRowId: "dispatch-decompose-fallback",
          ceiling: sourceSessionId ? ceilingForSession(String(sourceSessionId)) : "read-only",
          decidedAt: Date.now(),
          evidence: { sessionId: String(sourceSessionId ?? "") },
          reasonRedacted: redactSecrets(`${reason}；需求：${req.slice(0, 200)}`),
          reviewVerdict: "manual",
          reviewModelId: resolved.modelId,
          reviewTokens: "unknown",
          reviewReason: reason.slice(0, 200),
          pipelineMs: res && "latencyMs" in res && res.latencyMs ? res.latencyMs : undefined,
        });
        if (sourceSessionId) {
          try {
            await this.sendPrompt(sourceSessionId, req);
            this.set({ notice: `${reason}，已降级为直接回答（原文已发送，可重拆）` });
          } catch (e) {
            this.set({ error: `拆解失败且降级直答失败: ${String(e)}（原文保留：${req.slice(0, 80)}）` });
          }
        } else {
          this.set({ error: `${reason}（无源会话可降级直答，原文保留可重拆）` });
        }
        return;
      }
      // S2 确定性匹配（role/skill+ceiling+canOpenPath 双查+deny 剔除注理由；LLM assignee 仅建议）。
      const sess = sourceSessionId ? this.state.sessions.find((s) => s.sessionId === sourceSessionId) : undefined;
      const workspaceRoot = (sess as unknown as { cwd?: string } | undefined)?.cwd ?? this.state.host?.cwd ?? this.state.workspaces[0]?.path ?? null;
      const matched = matchDispatchCards(res.cards, employees, {
        workspaceRoot,
        canOpenPath: this.state.host?.canOpenPath ?? null,
      });
      const directIds = matched.filter((c) => c.direct).map((c) => c.clientTaskId);
      // Q3 可信直派：仅可信无越界卡直派（先 claim 幂等领取，其余仍走确认卡；确认卡标注已直派）。
      if (directIds.length > 0) {
        for (const c of matched.filter((m) => m.direct)) {
          const added = addTaskCard({
            clientTaskId: c.clientTaskId,
            title: c.title,
            inputScope: c.inputScope,
            outputTo: c.outputTo,
            forbidden: c.forbidden,
            approvalNote: `${c.approvalNote}（可信直派免确认：${c.assigneeName ?? ""}）`,
            assigneeEmployeeId: c.assigneeEmployeeId ?? "",
            status: "todo",
            queued: c.queued,
          });
          if (!added.ok) {
            this.set({ notice: `同卡重发被拒（clientTaskId 去重）：${c.title}` });
            continue;
          }
          if (!c.queued) {
            await this.dispatchOneCard(c, sourceSessionId);
          }
        }
        this.set({ notice: `其中 ${directIds.length} 张可信卡已直派（免确认），其余仍需确认` });
      }
      const rest = matched.filter((m) => !m.direct);
      if (rest.length === 0) {
        // 全直派：无确认卡，直接聚合回流提示。
        await this.refreshDispatchEvidence();
        return;
      }
      this.set({
        pendingDispatch: {
          id: `dispatch-${Date.now().toString(36)}`,
          requirement: req,
          sourceSessionId,
          // 确认卡含全部卡：直派卡顶置灰化不可编辑（badge green“已直派免确认”），其余可改派/减卡/取消。
          cards: matched,
          directCardIds: directIds,
          dispatchModelId: resolved.modelId,
          createdAt: Date.now(),
        },
      });
    } finally {
      this.set({ dispatchBusy: false });
    }
  }

  /** S3 取消（非直派卡；直派卡已执行不可撤回，确认卡注明）。 */
  cancelDispatch(): void {
    if (!this.state.pendingDispatch) return;
    this.set({ pendingDispatch: null, notice: "已取消分派（未确认卡未产生新会话；已直派卡不受影响）" });
  }

  /**
   * S3 确认 → S4 执行（确认后才 claimClientTaskId 双域幂等领取；改派仅同团队存活员工；减卡/取消生效）。
   * overrides: cardId→assigneeId 重绑；removedIds 减卡。
   */
  async confirmDispatch(overrides?: { assignee?: Record<string, string>; removedIds?: string[] }): Promise<void> {
    const pending = this.state.pendingDispatch;
    if (!pending) return;
    const removed = new Set(overrides?.removedIds ?? []);
    const assign = overrides?.assignee ?? {};
    const direct = new Set(pending.directCardIds);
    const employees = loadEmployees();
    const alive = new Set(employees.map((e) => e.id));
    // 已直派卡跳过（灰化不可编辑，不重复 claim/分派；确认卡已标注）。
    const cards = pending.cards.filter((c) => !removed.has(c.clientTaskId) && !direct.has(c.clientTaskId)).map((c) => {
      const want = assign[c.clientTaskId];
      if (want && alive.has(want) && want !== c.assigneeEmployeeId) {
        const emp = employees.find((e) => e.id === want);
        // 改派仅允许同团队内存活员工（sessionIds 归属有效+canBindPath 真已在 S2 双查；此处再验存活）。
        return { ...c, assigneeEmployeeId: want, assigneeName: emp?.name ?? c.assigneeName, direct: false };
      }
      return c;
    });
    if (cards.length === 0) {
      this.set({ pendingDispatch: null, notice: "已取消分派（非直派卡全部减卡，未产生新会话；已直派卡不受影响）" });
      return;
    }
    // 无确认动作不产生新会话：先清 pending 再逐卡 claim+执行（claim 失败即重发拒绝+notice）。
    this.set({ pendingDispatch: null });
    let okCount = 0;
    let failCount = 0;
    for (const c of cards) {
      const added = addTaskCard({
        clientTaskId: c.clientTaskId,
        title: c.title,
        inputScope: c.inputScope,
        outputTo: c.outputTo,
        forbidden: c.forbidden,
        approvalNote: c.approvalNote,
        assigneeEmployeeId: c.assigneeEmployeeId ?? "",
        status: "todo",
        queued: c.queued,
      });
      if (!added.ok) {
        failCount++;
        this.set({ notice: `同卡重发被拒（clientTaskId 去重）：${c.title}` });
        setTaskStatus(c.clientTaskId, "review");
        continue;
      }
      if (c.queued) {
        // 超 4 路排队（按 clientTaskId 顺序；团长卡可 steer 插队，沿 PRD-003）。
        setTaskStatus(c.clientTaskId, "todo");
        okCount++;
        continue;
      }
      const ok = await this.dispatchOneCard(c, pending.sourceSessionId);
      if (ok) okCount++;
      else failCount++;
    }
    await this.refreshDispatchEvidence();
    // S6：单卡败→该卡转人工余卡继续；全败→整单转人工+notice+Trace 留痕。
    if (failCount > 0 && okCount === 0) {
      pushAuditRow({
        requestId: pending.id,
        source: "dsh-approval",
        verdict: "to-human",
        policyRowId: "dispatch-all-failed",
        ceiling: "read-only",
        decidedAt: Date.now(),
        evidence: { sessionId: String(pending.sourceSessionId ?? "") },
        reasonRedacted: redactSecrets(`整单分派失败，已转人工：${pending.requirement.slice(0, 200)}`),
        reviewVerdict: "manual",
        reviewModelId: pending.dispatchModelId,
        reviewTokens: "unknown",
        reviewReason: "全部卡片分派失败，整单转人工",
      });
      this.set({ error: `分派全部失败，已整单转人工（Trace 可定位，需求保留可重拆）` });
    } else if (failCount > 0) {
      this.set({ notice: `分派完成：${okCount} 成功，${failCount} 张已转人工（余卡继续）` });
    } else {
      this.set({ notice: `分派完成：${okCount} 张已下发（≤4 路并行，超限排队）` });
    }
  }

  /**
   * S4 双通道分派（只经 continuable/queue；jobs 只读；fork 派生标“派生自<短id>@<seq>”；cold/archived 显式禁派）。
   * 新任务 create+prompt queue；存量子任务 promptSubagent continuable，one-shot/不可用回退父会话注明。
   * 分派文案强制五段；返回 true=下发成功，false=该卡转人工（调用方计数）。
   */
  private async dispatchOneCard(card: MatchedDispatchCard, sourceSessionId: SessionId | null): Promise<boolean> {
    const api = this.state.api;
    if (!api) {
      setTaskStatus(card.clientTaskId, "review");
      this.set({ error: `分派失败（未连接）已转人工：${card.title}` });
      return false;
    }
    try {
      const employees = loadEmployees();
      const emp = employees.find((e) => e.id === card.assigneeEmployeeId) ?? null;
      const text = buildDispatchTaskPrompt(card);
      // cold/archived 显式禁派（沿 -team §6 空态）。
      const targetSid = emp?.sessionIds?.[0] ? (emp.sessionIds[0] as unknown as SessionId) : null;
      if (targetSid && this.state.archivedSessionIds.includes(targetSid)) {
        setTaskStatus(card.clientTaskId, "review");
        pushAuditRow({
          requestId: card.clientTaskId,
          source: "dsh-approval",
          verdict: "to-human",
          policyRowId: "dispatch-archived-blocked",
          ceiling: emp?.ceiling ?? "read-only",
          decidedAt: Date.now(),
          evidence: { sessionId: String(targetSid) },
          reasonRedacted: redactSecrets(`该会话已归档（已自动解绑，仅可读），禁派转人工：${card.title}`),
          reviewTokens: "unknown",
          reviewReason: "已归档禁派转人工",
        });
        this.set({ notice: `该会话已归档禁派，已转人工：${card.title}` });
        return false;
      }
      // 存量子任务优先：assignee 名下有 continuable 子代理即走 promptSubagent；否则新任务链。
      if (targetSid) {
        try {
          const catalog = this.state.subagentCatalogs.get(targetSid);
          const cont = catalog?.entries.find((e) => e.kind === "child" && (e as unknown as { mode?: string }).mode !== "one-shot");
          if (cont) {
            const childId = (cont as unknown as { childSessionId?: string; sessionId?: string }).childSessionId ?? (cont as unknown as { sessionId: string }).sessionId;
            if (childId) {
              const r = await (api as unknown as {
                subagents: { prompt: (a: unknown, s?: AbortSignal) => Promise<{ result: { ok: boolean; error?: { code: string; message: string } } }> };
              }).subagents.prompt(
                {
                  parentSessionId: targetSid,
                  childSessionId: childId,
                  mode: "continuable",
                  content: [{ type: "text", text }],
                },
                new AbortController().signal,
              );
              if (r.result.ok) {
                setTaskStatus(card.clientTaskId, "running", { sessionId: String(targetSid), seq: 0 });
                return true;
              }
              // one-shot/不可用回退父会话 prompt queue 并注明（S4）。
              const fb = await api.sessions.prompt({
                sessionId: targetSid,
                mode: "queue",
                content: [{ type: "text", text: `${text}\n（注：子代理 continuable 不可用，已回退父会话 queue）` }],
              } as never);
              if (fb.result.ok) {
                setTaskStatus(card.clientTaskId, "running", { sessionId: String(targetSid), seq: 0 });
                return true;
              }
            }
          }
        } catch {
          //  fall through to 新任务链
        }
      }
      // 新任务链：create(workspaceId)+selectModel+prompt queue（select 空白才可否则复用明示：沿 createSession 语义）。
      const wid = this.state.activeWorkspaceId ?? undefined;
      const cr = await api.sessions.create({ workspaceId: wid ?? undefined });
      if (!cr.result.ok) throw new Error(`${cr.result.error.code}: ${cr.result.error.message}`);
      const newId = cr.result.value.sessionId;
      // fork 派生标注（派生自<短id>@<seq>；seq 取源会话历史长度兜底 0）。
      if (sourceSessionId) {
        try {
          const hist = this.state.history.get(sourceSessionId);
          noteFork(String(newId), String(sourceSessionId), Array.isArray(hist) ? hist.length : 0);
        } catch {
          // 留痕失败不阻断分派
        }
      }
      // 归属到 assignee（1:N；会话→员工 1:1 双归属拒绝沿 team.ts；此处 best-effort，不抛）。
      if (emp) {
        try {
          const list = loadEmployees();
          const owner = employeeBySession(list, String(newId));
          if (!owner) {
            const { saveEmployees } = await import("../team");
            saveEmployees(list.map((e) => (e.id === emp.id ? { ...e, sessionIds: [...e.sessionIds, String(newId)] } : e)));
          }
        } catch {
          // ignore
        }
      }
      const sel = this.state.selectedModel;
      if (sel) {
        try {
          await api.sessions.selectModel({
            sessionId: newId,
            provider: sel.provider,
            model: sel.model,
            reasoningEffort: this.state.selectedReasoning ?? undefined,
          });
        } catch {
          // 模型选择失败不阻断分派
        }
      }
      const pr = await api.sessions.prompt({
        sessionId: newId,
        mode: "queue",
        content: [{ type: "text", text }],
      } as never);
      if (!pr.result.ok) throw new Error(`${pr.result.error.code}: ${pr.result.error.message}`);
      setTaskStatus(card.clientTaskId, "running", { sessionId: String(newId), seq: 0 });
      void this.refreshSessions().catch(() => {});
      return true;
    } catch (e) {
      // S6 单卡失败→该卡转人工（进申请中心计数即 audit+notice+Trace，余卡继续）。
      setTaskStatus(card.clientTaskId, "review");
      pushAuditRow({
        requestId: card.clientTaskId,
        source: "dsh-approval",
        verdict: "to-human",
        policyRowId: "dispatch-card-failed",
        ceiling: "read-only",
        decidedAt: Date.now(),
        evidence: { sessionId: String(sourceSessionId ?? "") },
        reasonRedacted: redactSecrets(`单卡分派失败转人工：${card.title}：${String(e).slice(0, 200)}`),
        reviewTokens: "unknown",
        reviewReason: String(e).slice(0, 200),
      });
      this.set({ notice: `单卡分派失败已转人工（余卡继续）：${card.title}` });
      return false;
    }
  }

  /**
   * S5 回流（只读 history/projection/queue/jobs 合并；通过/打回必须挂 sessionId+seq 证据；聚合≤5s 窗口）。
   * N 会话逐个 loadHistory 合并（节流：失败不抛，证据缺失即无证据禁通过由 UI disabled 强制）。
   */
  async refreshDispatchEvidence(): Promise<void> {
    const api = this.state.api;
    if (!api) return;
    const cards = listTaskCards().filter((c) => c.status === "running" || c.status === "todo");
    for (const c of cards) {
      const ev = c.evidence;
      if (!ev?.sessionId) continue;
      try {
        await this.loadHistory(ev.sessionId as unknown as SessionId, { maxMessages: 20 });
        const hist = this.state.history.get(ev.sessionId as unknown as SessionId);
        const seq = Array.isArray(hist) && hist.length > 0 ? hist.length : 0;
        if (seq > 0 && ev.seq === 0) setTaskStatus(c.clientTaskId, "review", { sessionId: ev.sessionId, seq });
        else if (seq > 0 && c.status === "running") setTaskStatus(c.clientTaskId, "review", { sessionId: ev.sessionId, seq });
      } catch {
        // 回流失败不抛（下次 5s 窗口重试；无证据卡不可标通过）。
      }
    }
  }

  /** S5 验收门：无证据禁通过（沿 PRD-003 FR-T106；question 仅计数不自动判）。 */
  passDispatchCard(clientTaskId: string): void {
    const card = listTaskCards().find((c) => c.clientTaskId === clientTaskId);
    if (!card) return;
    if (!card.evidence?.sessionId || typeof card.evidence.seq !== "number") {
      this.set({ error: "无证据不可标通过（需挂 sessionId+seq 回流证据）" });
      return;
    }
    setTaskStatus(clientTaskId, "passed", card.evidence);
    this.set({ notice: `任务卡已通过（证据 ${card.evidence.sessionId.slice(0, 8)}@${card.evidence.seq}）` });
  }

  /** S5 打回同样必须挂证据（无证据禁打回，避免幽灵验收）。 */
  rejectDispatchCard(clientTaskId: string): void {
    const card = listTaskCards().find((c) => c.clientTaskId === clientTaskId);
    if (!card) return;
    if (!card.evidence?.sessionId || typeof card.evidence.seq !== "number") {
      this.set({ error: "无证据不可打回（需挂 sessionId+seq 回流证据）" });
      return;
    }
    setTaskStatus(clientTaskId, "rejected", card.evidence);
    this.set({ notice: `任务卡已打回（证据 ${card.evidence.sessionId.slice(0, 8)}@${card.evidence.seq}）` });
  }

  async answerApproval(item: InteractiveItem, outcome: "allowed-once" | "rejected", opts?: { auto?: boolean }): Promise<void> {
    const api = this.requireApi();
    if (item.frame.type !== "approval/requested") return;
    const payload: ApprovalResponsePayload = {
      sessionId: item.sessionId,
      approvalId: item.frame.approvalId,
      outcome,
    };
    await api.respond({ type: "client-response", rpcId: item.rpcId, result: { ok: true, value: payload } });
    // 人工决（非自动）回填审计行终态；自动三判已在拦截器写入 auto-allow/auto-deny。
    if (!opts?.auto) markHumanDecided(String(item.frame.approvalId));
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
    // 21:00Z HANDOVER：旧 llm.providers 合并已删（POST /api/llm/providers→404），新链
    // llm/listProviders（活路由 [{id,name}]）+ llm/listConfigurableProviders（目录
    // [{provider,displayName,settingsNs,settingsPath,declared?}]）经 join（active=注册含 route，
    // 声明行在前、无声明活路由追加，即旧 providers 等价）。仍经 Rust 代理，不直连 3080。
    const api = this.requireApi() as unknown as {
      llmListProviders: () => Promise<{ result: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }>;
      llmListConfigurableProviders: () => Promise<{ result: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }>;
    };
    const [reg, dir] = await Promise.all([api.llmListProviders(), api.llmListConfigurableProviders()]);
    if (!reg.result.ok) {
      const e = (reg.result as { error: { code: string; message: string } }).error;
      throw new Error(`获取活路由失败: ${e.code}: ${e.message}`);
    }
    if (!dir.result.ok) {
      const e = (dir.result as { error: { code: string; message: string } }).error;
      throw new Error(`获取提供商目录失败: ${e.code}: ${e.message}`);
    }
    const regVal = reg.result.value as unknown;
    const registered: Array<{ id: string; name?: string }> = Array.isArray(regVal)
      ? (regVal as Array<{ id: string; name?: string }>)
      : Array.isArray((regVal as { providers?: unknown })?.providers)
        ? ((regVal as { providers: Array<{ id: string; name?: string }> }).providers)
        : [];
    const dirVal = dir.result.value as unknown;
    const directory: Array<{ provider: string; displayName: string; settingsNs: string; settingsPath: string[]; declared?: boolean }> =
      Array.isArray(dirVal)
        ? (dirVal as Array<{ provider: string; displayName: string; settingsNs: string; settingsPath: string[]; declared?: boolean }>)
        : Array.isArray((dirVal as { providers?: unknown })?.providers)
          ? ((dirVal as { providers: Array<{ provider: string; displayName: string; settingsNs: string; settingsPath: string[]; declared?: boolean }> }).providers)
          : [];
    const liveSet = new Set(registered.map((r) => r.id));
    const out: ConfigurableProviderView[] = directory.map((d) => ({
      ...(d as unknown as ConfigurableProviderView),
      active: liveSet.has(d.provider),
    }));
    for (const r of registered) {
      if (!directory.some((d) => d.provider === r.id)) {
        const isDeepseek = /deepseek/i.test(r.id) || /deepseek/i.test(r.name ?? "");
        out.push({
          provider: r.id,
          displayName: r.name ?? r.id,
          settingsNs: isDeepseek ? "llm-deepseek" : "llm-pi-ai",
          settingsPath: isDeepseek ? [] : [r.id],
          active: true,
          declared: false,
        } as unknown as ConfigurableProviderView);
      }
    }
    return out;
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
    // 21:00Z HANDOVER：旧扁平 discoverModels({settingsNs,provider?,baseURL?,api?,apiKey?}) 已拆键，
    // 新形 args:{settingsNs,request:{provider?,baseURL?,api?,apiKey?}}（wire 拆出首键 settingsNs）。
    // 仍经 Rust 代理，不直连 3080。
    const api = this.requireApi() as unknown as {
      llmDiscoverModels: (args: { settingsNs: string; request: { provider?: string; baseURL?: string; api?: string; apiKey?: string } }) => Promise<{ result: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }>;
    };
    const request: { provider?: string; baseURL?: string; api?: string; apiKey?: string } = {};
    if (opts.provider !== undefined) request.provider = opts.provider;
    if (opts.baseURL !== undefined) request.baseURL = opts.baseURL;
    if (opts.api !== undefined) request.api = opts.api;
    if (opts.apiKey !== undefined) request.apiKey = opts.apiKey;
    const r = await api.llmDiscoverModels({ settingsNs: opts.settingsNs, request });
    if (r.result.ok) return (r.result.value as { models: DiscoveredModelView[] }).models;
    const e = (r.result as { error: { code: string; message: string } }).error;
    throw new Error(`探测失败: ${e.message || e.code}`);
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
    // 21:00Z HANDOVER：旧 llm.models → session/modelCatalog 超集（含 default+routableProviders），取 groups。
    // 信封 POST /api/session/modelCatalog + payload:{args:{}}，仍经 Rust 代理。
    const api = this.requireApi() as unknown as {
      sessionModelCatalog: () => Promise<{ result: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }>;
    };
    const r = await api.sessionModelCatalog();
    if (r.result.ok) return (r.result.value as { groups: ModelProviderGroup[] }).groups;
    const e = (r.result as { error: { code: string; message: string } }).error;
    throw new Error(`获取模型目录失败: ${e.code}: ${e.message}`);
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
      // PRD-003：fork 派生显式标注“派生自 <短id>@<seq>”（黑板 + notice，原会话保留不动）。
      noteFork(newId, sessionId, seq);
      this.set({
        selectedSessionId: newId,
        notice: `已分叉：新会话 ${newId}（派生自 ${sessionId.slice(0, 8)}@${seq}），原会话保留未动。`,
      });
      await this.refreshSessions();
      await this.loadHistory(newId);
    } catch (e) {
      this.set({ error: `分叉失败: ${String(e)}` });
    }
  }

  async loadAgentPresets(): Promise<void> {
    const api = this.requireApi();
    try {
      // 19:00Z HANDOVER 单数→复数：POST /api/agentPresets/list + args:{}（仍经 Rust 代理）。
      // 新 list 无 hasDocument（仅 {presets,authorable}），hasDocument 改源 settings/canOpenAgentPresetDirectory。
      const r = await api.agentPresetsList();
      if (r.result.ok) {
        const v = r.result.value as { presets: AgentPresetEntry[]; authorable: boolean; hasDocument?: boolean };
        let hasDocument = typeof v.hasDocument === "boolean" ? v.hasDocument : false;
        try {
          const c = await api.settingsCanOpenAgentPresetDirectory();
          if (c.result.ok) hasDocument = Boolean(c.result.value as unknown);
        } catch {
          // best-effort：canOpen 失败保持 false，不阻断列表
        }
        this.set({
          agentPresets: v.presets as AgentPresetEntry[],
          agentPresetsMeta: { authorable: v.authorable, hasDocument },
          agentPresetsError: null,
        });
      } else {
        const msg = `读取 Agent 模式失败: ${r.result.error.code}: ${r.result.error.message}`;
        this.set({ error: msg, agentPresetsError: msg });
      }
    } catch (e) {
      const msg = `读取 Agent 模式失败: ${String(e)}`;
      this.set({ error: msg, agentPresetsError: msg });
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
      await api.agentPresetsSelect({ agentId: id, agentPreset });
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
      const r = await api.agentPresetsSelect({ agentId: sessionId, agentPreset });
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
   * 任务#15+#14 自动取名（复用 sessionTitles/rename 落点 + 取名模型参数）。
   * - 未配置 titleModel（provider/model 缺失）= 直接返回，零打扰（不调用模型、不改标题、不抛错）。
   * - 已有本地/投影标题 = 跳过（不覆盖手动重命名）。
   * - 复用隔离会话链（sessions.create→selectModel(取名模型)→prompt queue→page 轮询≤60s），与二判同构；失败静默跳过。
   * - 成功经 renameSession 落点（本地表 + dsh user 源），仍经 Rust 代理；零新增 invoke/事件。
   */
  private runTitleModel(
    prompt: string,
    model: { provider: string; model: string; reasoningEffort?: string },
  ): Promise<string | null> {
    const task = (async (): Promise<string | null> => {
      const api = this.state.api;
      if (!api) return null;
      const t0 = Date.now();
      try {
        const cr = await api.sessions.create({});
        if (!cr.result.ok) return null;
        const isoId = cr.result.value.sessionId;
        try {
          await api.sessions.selectModel({
            sessionId: isoId,
            provider: model.provider,
            model: model.model,
            reasoningEffort: model.reasoningEffort ?? undefined,
          } as never).catch(() => undefined);
        } catch {
          // 选模型失败不阻断，沿用会话默认（失败则静默跳过）
        }
        const pr = await api.sessions.prompt({
          sessionId: isoId,
          mode: "queue",
          content: [{ type: "text", text: prompt }],
        } as never);
        if (!pr.result.ok) return null;
        const deadline = t0 + AUTO_REVIEW_TIMEOUT_SECS * 1000;
        while (Date.now() < deadline) {
          await sleepMs(2000);
          try {
            const text = await this.isolationAssistantText(api, isoId, 20);
            if (!text) continue;
            const title = parseTitleText(text);
            if (title) return title;
            return null;
          } catch {
            return null;
          }
        }
        return null;
      } catch {
        return null;
      }
    })();
    const chained = titleChain.then(() => task);
    titleChain = chained.then(() => undefined).catch(() => undefined);
    return chained;
  }

  /** 自动取名入口（fire-and-forget，失败零打扰；并发同会话去重）。 */
  autoTitleSession(sessionId: SessionId, firstText: string): void {
    try {
      const key = String(sessionId);
      const titleVal = this.state.titleModel?.value ?? null;
      if (!titleVal || !titleVal.provider || !titleVal.model) return;
      if (pendingTitles.has(key)) return;
      const sess = this.state.sessions.find((s) => String(s.sessionId) === key) as unknown as
        | { projections?: { values?: { title?: unknown } } }
        | undefined;
      const projected = (sess?.projections?.values as Record<string, unknown> | undefined)?.title;
      const hasProjected = typeof projected === "string" && !!projected;
      if (this.state.sessionTitles[key] || hasProjected) return;
      const snippet = (firstText ?? "").trim();
      if (!snippet) return;
      pendingTitles.add(key);
      const prompt = buildTitlePrompt(snippet);
      const model = { provider: titleVal.provider, model: titleVal.model, ...(titleVal.reasoningEffort ? { reasoningEffort: titleVal.reasoningEffort } : {}) };
      void this.runTitleModel(prompt, model)
        .then((title) => {
          pendingTitles.delete(key);
          if (!title) return;
          // 二次确认仍无标题才写（防手动重命名竞态覆盖）。
          const cur = this.state.sessionTitles[key];
          if (cur) return;
          void this.renameSession(sessionId, title).catch(() => {});
        })
        .catch(() => {
          pendingTitles.delete(key);
        });
    } catch {
      // 零打扰：任何同步异常静默跳过
    }
  }

  /**
   * 设置「未来新会话」的默认权限预设（permission settings 命名空间，live 生效）。
   * 注：切换「当前会话」权限是 dsh 宿主侧 `/permission` 命令（Typert commands.execute，
   * 外部浏览器客户端经 apiproxy 无法调用，且经 session.prompt 发送会被当作普通消息触发模型回合）。
   */
  async setDefaultPermissionPreset(preset: string): Promise<void> {
    const normalized = normalizePermissionValue(preset);
    // PRD-004 FR-M201 回退①：auto-review 永不写 dsh（dsh 会拒识）：本地 flag + dsh 侧保持 ask 兜底。
    if (isAutoReviewValue(preset) || normalized === "auto-review") {
      setAutoReviewEnabled(true);
      this.set({ notice: "已启用本地自动审核（dsh侧保持询问审批兜底）" });
      return;
    }
    // PRD-003 FR-T202 冻结：完全访问本轮禁用，选即回退（不写 dsh，只出 notice）。
    if (preset === "danger-full-access" || preset === "完全访问") {
      this.set({ notice: "完全访问已被 PRD-003 禁用，已回退为询问审批" });
      return;
    }
    // 回退③：关闭该档即删本地 flag，dsh 侧值原样有效，零残留。
    if (isAutoReviewEnabled()) setAutoReviewEnabled(false);
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
    let options = permissionSchemaEnums(ns?.schema).map((v) => ({ value: v, name: v }));
    // PRD-004 FR-M201：dsh schema 枚举之后本地追加一档；别名 auto_audit 归一为 auto-review 不双列。
    const hasReview = options.some((o) => isAutoReviewValue(o.value));
    const hasAuditAliasOnly = options.some((o) => o.value === "auto_audit") && !options.some((o) => o.value === "auto-review");
    if (hasAuditAliasOnly) {
      options = options.filter((o) => o.value !== "auto_audit");
      options.push({ value: "auto-review", name: "auto-review" });
    } else if (!hasReview) {
      options.push({ value: "auto-review", name: "auto-review" });
    } else {
      // 上游未来自带真 auto-review：去重本地档，优先上游值（R-01）。
      const seen = new Set<string>();
      options = options.filter((o) => {
        const n = normalizePermissionValue(o.value);
        if (n === "auto-review") {
          if (seen.has("auto-review")) return false;
          seen.add("auto-review");
          o.value = "auto-review";
          o.name = "auto-review";
        }
        return true;
      });
    }
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
    const r = await api.agentPresetsCopy({ from, id, name: name?.trim() || undefined });
    if (!r.result.ok) {
      this.set({ error: `复制 Agent 模式失败: ${r.result.error.code}: ${r.result.error.message}` });
      return;
    }
    await this.loadAgentPresets();
  }

  async removeAgentPreset(id: string): Promise<void> {
    const api = this.requireApi();
    const r = await api.agentPresetsDelete({ id });
    if (!r.result.ok) {
      this.set({ error: `删除 Agent 模式失败: ${r.result.error.code}: ${r.result.error.message}` });
      return;
    }
    await this.loadAgentPresets();
  }

  async readAgentPreset(id: string): Promise<{ content: string; name?: string; description?: string } | null> {
    const api = this.requireApi();
    const r = await api.agentPresetsRead({ agentPreset: id });
    if (!r.result.ok) {
      this.set({ error: `读取组装失败: ${r.result.error.code}: ${r.result.error.message}` });
      return null;
    }
    return { content: r.result.value.content, name: r.result.value.name, description: r.result.value.description };
  }

  async openAgentPresetDocument(id: string): Promise<void> {
    const api = this.requireApi();
    try {
      const r = await api.settingsOpenAgentPresetDirectory({ agentPreset: id });
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
    // 23:50Z HANDOVER：旧 flat {sessionId}→新 wire {request:{sessionId}}（WorkspaceArchiveSessionRequest），仍经 Rust 代理。
    const r = await api.workspaceArchiveSession({ sessionId });
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

  // ---- settings 域补全：describe-all / update / replace / openDocument ----

  /** 读取全部设置命名空间（settings.describe 原始视图）。 */
  async describeSettings(): Promise<{ writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] } | null> {
    const api = this.requireApi();
    const r = await api.settings.describe({});
    if (!r.result.ok) {
      this.set({ error: `读取设置失败: ${r.result.error.code}: ${r.result.error.message}` });
      return null;
    }
    return r.result.value;
  }

  /** 合并补丁到命名空间用户层（settings.update；secret 字段仅写不读）。 */
  async updateSettings(ns: string, patch: object, expectedRevision?: number): Promise<void> {
    const api = this.requireApi();
    const r = await api.settings.update({ ns, patch, expectedRevision });
    if (!r.result.ok) {
      throw new Error(`设置更新被拒绝: ${r.result.error.message || r.result.error.code}`);
    }
  }

  // ---- agent-default-model（dsh 0.1.1-rc.2 新增命名空间：新会话默认模型） ----

  /** 读取全局默认模型视图（settings.describe 的 agent-default-model 命名空间）。 */
  async loadDefaultModel(): Promise<void> {
    try {
      const d = await this.describeSettings();
      const ns = d?.namespaces.find((n) => n.ns === "agent-default-model");
      if (!ns) {
        this.set({ defaultModel: null, autoReviewModel: null, titleModel: null, dispatchModel: null });
        return;
      }
      const raw = (ns.value ?? null) as ({ provider?: string; model?: string; reasoningEffort?: string; autoReview?: { provider?: string; model?: string; reasoningEffort?: string }; titleModel?: { provider?: string; model?: string; reasoningEffort?: string }; dispatchModel?: { mode?: string; provider?: string; model?: string; reasoningEffort?: string } } | null);
      const topValue =
        raw && typeof raw.provider === "string" && typeof raw.model === "string"
          ? { provider: raw.provider, model: raw.model, ...(raw.reasoningEffort ? { reasoningEffort: raw.reasoningEffort } : {}) }
          : null;
      // FR-M202 存储选①：同 ns 加平行 autoReview 字段；读无此值容忍关闭（value null，不报错）。
      const autoRaw = raw?.autoReview ?? null;
      const autoValue =
        autoRaw && typeof autoRaw.provider === "string" && autoRaw.provider.trim() && typeof autoRaw.model === "string" && autoRaw.model.trim()
          ? { provider: autoRaw.provider, model: autoRaw.model, ...(autoRaw.reasoningEffort ? { reasoningEffort: autoRaw.reasoningEffort } : {}) }
          : null;
      // 任务#15+#14 存储复用：同 ns 加平行 titleModel 字段，一次 CAS；读无此值=不自动取名，零打扰。
      const titleRaw = raw?.titleModel ?? null;
      const titleValue =
        titleRaw && typeof titleRaw.provider === "string" && titleRaw.provider.trim() && typeof titleRaw.model === "string" && titleRaw.model.trim()
          ? { provider: titleRaw.provider, model: titleRaw.model, ...(titleRaw.reasoningEffort ? { reasoningEffort: titleRaw.reasoningEffort } : {}) }
          : null;
      // PRD-dispatch Q2：同 ns 加平行 dispatchModel 字段，一次 CAS；默认 follow-default，未配回落默认+提示。
      const dispRaw = raw?.dispatchModel ?? null;
      const dispMode: DispatchModelSetting["mode"] = dispRaw?.mode === "specified" ? "specified" : "follow-default";
      const dispSetting: DispatchModelSetting | null = dispRaw
        ? {
            mode: dispMode,
            ...(typeof dispRaw.provider === "string" && dispRaw.provider.trim() ? { provider: dispRaw.provider } : {}),
            ...(typeof dispRaw.model === "string" && dispRaw.model.trim() ? { model: dispRaw.model } : {}),
            ...(typeof dispRaw.reasoningEffort === "string" && dispRaw.reasoningEffort ? { reasoningEffort: dispRaw.reasoningEffort } : {}),
          }
        : null;
      this.set({
        defaultModel: {
          value: topValue,
          revision: ns.revision,
          applies: ns.applies,
        },
        autoReviewModel: {
          value: autoValue,
          revision: ns.revision,
          applies: ns.applies,
        },
        titleModel: {
          value: titleValue,
          revision: ns.revision,
          applies: ns.applies,
        },
        dispatchModel: {
          setting: dispSetting,
          revision: ns.revision,
          applies: ns.applies,
        },
      });
    } catch {
      // 目录未就绪等场景不阻塞；UI 保持 null
    }
  }

  /** 保存全局默认模型（settings.update + expectedRevision CAS，成功后刷新视图）。 */
  async saveDefaultModel(
    patch: { provider: string; model: string; reasoningEffort?: string },
    expectedRevision?: number,
  ): Promise<void> {
    await this.updateSettings("agent-default-model", patch, expectedRevision);
    await this.loadDefaultModel();
  }

  /** PRD-004 FR-M202：保存自动审核模型（同 ns 加 autoReview 字段，一次 updateSettings CAS）。 */
  async saveAutoReviewModel(
    patch: { provider: string; model: string; reasoningEffort?: string },
    expectedRevision?: number,
  ): Promise<void> {
    await this.updateSettings("agent-default-model", { autoReview: patch }, expectedRevision);
    await this.loadDefaultModel();
  }

  /** 任务#15+#14：保存标题取名模型（同 ns 加平行 titleModel 字段，一次 updateSettings CAS）。 */
  async saveTitleModel(
    patch: { provider: string; model: string; reasoningEffort?: string },
    expectedRevision?: number,
  ): Promise<void> {
    await this.updateSettings("agent-default-model", { titleModel: patch }, expectedRevision);
    await this.loadDefaultModel();
  }

  /** PRD-dispatch Q2：保存拆解模型（同 ns 加平行 dispatchModel 字段，一次 updateSettings CAS；默认 follow-default）。 */
  async saveDispatchModel(
    patch: DispatchModelSetting,
    expectedRevision?: number,
  ): Promise<void> {
    const clean: DispatchModelSetting =
      patch.mode === "specified"
        ? {
            mode: "specified",
            ...(patch.provider?.trim() ? { provider: patch.provider.trim() } : {}),
            ...(patch.model?.trim() ? { model: patch.model.trim() } : {}),
            ...(patch.reasoningEffort?.trim() ? { reasoningEffort: patch.reasoningEffort.trim() } : {}),
          }
        : { mode: "follow-default" };
    await this.updateSettings("agent-default-model", { dispatchModel: clean }, expectedRevision);
    await this.loadDefaultModel();
  }

  /** 整体替换命名空间用户层（settings.replace；section={} 即恢复默认）。 */
  async replaceSettings(ns: string, section: object, expectedRevision?: number): Promise<void> {
    const api = this.requireApi();
    const r = await api.settings.replace({ ns, section, expectedRevision });
    if (!r.result.ok) {
      throw new Error(`设置重置被拒绝: ${r.result.error.message || r.result.error.code}`);
    }
  }

  /** 用系统编辑器打开设置文档（settings.openDocument）。 */
  async openSettingsDocument(): Promise<void> {
    const api = this.requireApi();
    const r = await api.settings.openDocument({}, new AbortController().signal);
    if (!r.result.ok) {
      throw new Error(`打开设置文档失败: ${r.result.error.message || r.result.error.code}`);
    }
  }

  // ---- workspace 域补全：排序 ----

  /** 工作区显示顺序调整（workspace.insertBefore；anchor 省略=移到末尾）。 */
  async moveWorkspace(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    const api = this.requireApi();
    const r = await api.workspace.insertBefore({ workspaceId, beforeWorkspaceId });
    if (!r.result.ok) {
      this.set({ error: `工作区排序失败: ${r.result.error.code}: ${r.result.error.message}` });
      return;
    }
    await this.refreshWorkspaces();
  }

  /** 会话在工作区内手动排序（workspace.insertSessionBefore）。 */
  async moveSessionInWorkspace(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<void> {
    const api = this.requireApi();
    const r = await api.workspace.insertSessionBefore({ workspaceId, sessionId, beforeSessionId });
    if (!r.result.ok) {
      this.set({ error: `会话排序失败: ${r.result.error.code}: ${r.result.error.message}` });
      return;
    }
    await this.refreshWorkspaces();
    await this.refreshSessions();
  }

  // ---- host 域补全：openPath ----

  /** 用系统默认程序打开路径（host.openPath，资源管理器/编辑器）。 */
  async openPath(path: string): Promise<void> {
    const api = this.requireApi();
    const r = await api.host.openPath({ path }, new AbortController().signal);
    if (!r.result.ok) {
      throw new Error(`打开路径失败: ${r.result.error.message || r.result.error.code}`);
    }
  }

  // ---- subagent 域：list / history / prompt / interrupt ----

  /** 加载父会话的直接子代理目录（subagent.list）。 */
  async loadSubagents(parentSessionId: SessionId): Promise<void> {
    const api = this.requireApi();
    const r = await api.subagents.list({ parentSessionId });
    if (!r.result.ok) {
      this.set({ error: `读取子代理失败: ${r.result.error.code}: ${r.result.error.message}` });
      return;
    }
    const m = new Map(this.state.subagentCatalogs);
    m.set(parentSessionId, r.result.value);
    this.set({ subagentCatalogs: m });
  }

  /**
   * 17:30Z：子代理无 list 行投影可取 cursor，以 page 二分探最大合法 throughSeq（-1 必合法为空下界；
   * 超 cursor 即 bad-request 为上界信号；探针 maxMessages=1 减负，仍经代理）。其他错误（404/401/信封错）即停返 null。
   */
  private async discoverThroughSeq(
    address:
      | { kind: "session"; sessionId: string }
      | { kind: "subagent"; parentSessionId: string; childSessionId: string; mode: "one-shot" | "continuable" },
  ): Promise<number | null> {
    const api = this.requireApi() as unknown as {
      sessionPage: (req: unknown) => Promise<{ result: { ok: boolean; error?: { code: string; message: string } } }>;
    };
    const probe = async (throughSeq: number): Promise<"valid" | "over" | "fatal"> => {
      try {
        const r = await api.sessionPage({ address, throughSeq, maxMessages: 1 });
        if (r.result.ok) return "valid";
        const code = r.result.error?.code ?? "";
        const msg = r.result.error?.message ?? "";
        const over = code.includes("bad-request") || msg.includes("bad-request") || msg.includes("throughSeq") || msg.includes("cursor");
        return over ? "over" : "fatal";
      } catch (e) {
        const msg = String(e);
        if (msg.includes("bad-request") || msg.includes("throughSeq") || msg.includes("cursor")) return "over";
        if (msg.includes("HTTP 404") || msg.includes("HTTP 401") || msg.includes("HTTP 403") || msg.includes("HTTP 502")) return "fatal";
        return "fatal";
      }
    };
    if ((await probe(-1)) === "fatal") return null;
    let low = -1;
    let high = 50;
    for (let i = 0; i < 8; i++) {
      const st = await probe(high);
      if (st === "valid") {
        low = high;
        if (high >= 10_000_000) return low;
        high *= 4;
        continue;
      }
      if (st === "over") break;
      return null;
    }
    // 二分夹逼最大合法 throughSeq（=cursor；空日志时仍 -1）。
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      const st = await probe(mid);
      if (st === "valid") low = mid;
      else if (st === "over") high = mid;
      else return null;
    }
    return low;
  }

  /** 读取子代理历史（17:30Z：旧 subagents.history 已移除→session/page，address.kind=subagent；records 取 event；仍经代理）。 */
  async loadSubagentHistory(parentSessionId: SessionId, childSessionId: SessionId, mode: "one-shot" | "continuable"): Promise<void> {
    const api = this.requireApi();
    const address = {
      kind: "subagent",
      parentSessionId: parentSessionId as string,
      childSessionId: childSessionId as string,
      mode,
    } as const;
    let throughSeq: number | null = null;
    try {
      throughSeq = await this.discoverThroughSeq({ ...address });
    } catch {
      throughSeq = null;
    }
    if (throughSeq === null) {
      this.set({ error: "读取子代理记录失败：无已知 cursor 且探活失败（需 follow snapshot，待后端另单确认代理路径）" });
      return;
    }
    let r: { result: { ok: boolean; value?: unknown; error?: { code: string; message: string } } };
    try {
      r = (await (api as unknown as {
        sessionPage: (req: unknown) => Promise<typeof r>;
      }).sessionPage({ address: { ...address }, throughSeq, maxMessages: 100 })) as typeof r;
    } catch (e) {
      const msg = String(e);
      this.set({ error: `读取子代理记录失败${pageErrorHint(msg)}: ${msg}` });
      return;
    }
    if (!r.result.ok) {
      const err = r.result.error as { code: string; message: string };
      this.set({ error: `读取子代理记录失败${pageErrorHint(`${err.code}: ${err.message}`)}: ${err.code}: ${err.message}` });
      return;
    }
    const records = (r.result.value as { records?: unknown }).records ?? [];
    const entries = pageRecordsToHistoryEntries(records);
    const m = new Map(this.state.subagentHistories);
    m.set(childSessionId, entries as unknown as HistoryEntry[]);
    this.set({ subagentHistories: m });
  }

  /** 向可继续子代理发送人类消息（subagent.prompt；仅 continuable）。 */
  async promptSubagent(parentSessionId: SessionId, childSessionId: SessionId, text: string): Promise<void> {
    const api = this.requireApi();
    const r = await api.subagents.prompt(
      {
        parentSessionId,
        childSessionId,
        mode: "continuable",
        content: [{ type: "text", text }] as never,
      },
      new AbortController().signal,
    );
    if (!r.result.ok) {
      this.set({ error: `子代理消息失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
  }

  /** 中断运行中的可继续子代理当前回合（subagent.interrupt；仅 continuable）。 */
  async interruptSubagent(parentSessionId: SessionId, childSessionId: SessionId): Promise<void> {
    const api = this.requireApi();
    const r = await api.subagents.interrupt({ parentSessionId, childSessionId, mode: "continuable" });
    if (!r.result.ok) {
      this.set({ error: `中断子代理失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
  }

  // ---- skill 域：list ----

  /** 加载会话项目的技能目录（skill.list；调用即 /name 触发）。
   * 冷会话（attached = 本进程内有活跃 agent，需先产生模型回合）不可用时进入 skillsUnavailable 提示态。 */
  async loadSkills(sessionId: SessionId): Promise<void> {
    const api = this.requireApi();
    const r = await api.skills.list({ sessionId });
    if (!r.result.ok) {
      if (r.result.error.code === "session-not-found") {
        this.set({ skills: null, skillsUnavailable: true });
        return;
      }
      this.set({ skills: null, skillsUnavailable: false, error: `读取技能失败: ${r.result.error.code}: ${r.result.error.message}` });
      return;
    }
    this.set({ skills: [...r.result.value.skills], skillsUnavailable: false });
  }

  // ---- goal 域：create / edit / pause / resume / complete / clear ----
  // 读侧走 goal 投影（projections.goal），变更经 mux 的 session/projection 帧回推 UI。

  /** 当前会话目标视图（投影存储读取；null=无目标）。 */
  currentGoal(sessionId: SessionId): { goal: { id: string; revision: number; objective: string; phase: string; maxGoalRounds: number }; roundsStarted: number } | null {
    const v = this.state.projections.get(sessionId)?.["goal"]?.value as
      | { goal: { id: string; revision: number; objective: string; phase: string; maxGoalRounds: number }; roundsStarted: number }
      | null
      | undefined;
    return v && v.goal ? v : null;
  }

  async goalCreate(sessionId: SessionId, objective: string, maxGoalRounds?: number): Promise<void> {
    const api = this.requireApi();
    const r = await api.goals.create({ sessionId, objective, maxGoalRounds });
    if (!r.result.ok) {
      this.set({ error: `创建目标失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
  }

  async goalEdit(sessionId: SessionId, ref: GoalRef, objective?: string, maxGoalRounds?: number): Promise<void> {
    const api = this.requireApi();
    const r = await api.goals.edit({ sessionId, ref, objective, maxGoalRounds });
    if (!r.result.ok) {
      this.set({ error: `编辑目标失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
  }

  async goalPause(sessionId: SessionId, ref: GoalRef): Promise<void> {
    const api = this.requireApi();
    const r = await api.goals.pause({ sessionId, ref });
    if (!r.result.ok) {
      this.set({ error: `暂停目标失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
  }

  async goalResume(sessionId: SessionId, ref: GoalRef): Promise<void> {
    const api = this.requireApi();
    const r = await api.goals.resume({ sessionId, ref });
    if (!r.result.ok) {
      this.set({ error: `恢复目标失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
  }

  async goalComplete(sessionId: SessionId, ref: GoalRef): Promise<void> {
    const api = this.requireApi();
    const r = await api.goals.complete({ sessionId, ref });
    if (!r.result.ok) {
      this.set({ error: `完成目标失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
  }

  async goalClear(sessionId: SessionId, ref: GoalRef): Promise<void> {
    const api = this.requireApi();
    const r = await api.goals.clear({ sessionId, ref });
    if (!r.result.ok) {
      this.set({ error: `清除目标失败: ${r.result.error.code}: ${r.result.error.message}` });
    }
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

  /** 置位待插入输入框的技能名（会话功能坞「技能」子tab 点击技能时调用；WorkSessionView 消费后调用 setSkillInsert(null) 清空）。 */
  setSkillInsert(name: string | null): void {
    this.set({ pendingSkillInsert: name });
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

