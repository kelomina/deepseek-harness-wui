/**
 * Protocol client: official protocol core (AbstractApiClient from
 * @deepseek-ai/dsh-host-apiproxy/client) + official browser WebSocket
 * transport (reimplemented from the MIT-licensed WebApiClient bundle).
 *
 * All traffic targets the local Tauri proxy (127.0.0.1:<proxy_port>), which
 * strips browser Origin and forwards to dsh — required because dsh rejects
 * non-loopback Origins at /api.
 *
 * 0.1.2-rc.1 Typert 网关对齐（2026-09-06，前端垫片，无 npm 升级）：
 * - 运行时 0.1.2-rc.1 为 slash 网关：POST /api/<ns>/<method>（claimsEndpoint
 *   split('/')len==2，见 dsh-api-gateway/types/index.js:128-132），dot 记法永不
 *   claim（/api/host.describe → 404 not found，与代理透传 body 一致）。
 * - 信封仍为全量 {type:'client-request', rpcId, method, payload}（见
 *   dsh-client-connection/lib/index.js:rpcFetchHandler），但 method 必须等于
 *   endpoint（slash），且 payload 必须恰为 {args: plainObject}（见
 *   dsh-api-gateway remoteRequest：payload 仅含 args 一键）。
 * - 本类 override callUnary 做 dot→slash + {args} 包裹，沿用旧包信封级
 *   serverResponseSchema 校验；有意跳过旧 UNARY_VALUE_SCHEMAS 第二级值解析
 *   （新值演进会被旧 zod 误拒），业务值透传由调用方断言。
 * - host 命名空间已移除（新路由表无 host/*），首包不再调 host.describe，
 *   改由 store.ts 用 session/list 探活。事件仍走旧 /api/events.*（新
 *   /api/remote.mux 迁移另单）。
 */
import { AbstractApiClient } from "@deepseek-ai/dsh-host-apiproxy/client";
import { serverRequestSchema, serverResponseSchema } from "@deepseek-ai/dsh-host-apiproxy/api";
import {
  hostFrameSchema,
  muxFrameSchema,
} from "@deepseek-ai/dsh-host-apiproxy/api/events.schema";
import type { HostFrame, MuxFrame, RpcRequest } from "@deepseek-ai/dsh-host-apiproxy/api";

const MUX_EVENTS_PATH = "/api/events.mux";
const HOST_EVENTS_PATH = "/api/events.host";

type Schema<T> = { parse(value: unknown): T };

export class DshApiClient extends AbstractApiClient {
  constructor(
    private readonly baseUrl: string,
    timeoutMs?: number,
  ) {
    super(timeoutMs);
  }

  protected resolveBase(): string {
    return this.baseUrl;
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return fetch(input, init);
  }

  /**
   * 0.1.2-rc.1 slash 垫片：dot→slash + payload→{args}。
   * 覆盖父类 dot 直发（POST /api/${dotMethod}），改为 POST /api/<ns>/<method>
   * 且 method==endpoint；超时语义与父类 postJson 一致（default 合并
   * AbortSignal.timeout，caller-signal-only 仅透传外部 signal）。
   */
  /**
   * 17:30Z HANDOVER 新 page/follow 映射：session/page 的 wire 键为 `request`（非 `_request`），
   * 旧 sessions.history/subagents.history 已移除（POST /api/session/history→404 未 claim）。
   *
   * 19:00Z HANDOVER 单数→复数改名：旧 `agentPreset.*` 单数 dot 已移除（POST /api/agentPreset/list→404 未 claim），
   * 新网关为复数 `agentPresets/*` + `settings/*PresetDirectory`（运行时 0.1.2-rc.1）。
   * 新调用点请直调以下 helpers（slash 复数 + 新 args 形状），仍经 Rust 代理，不直连 3080。
   */
  public agentPresetsList(signal?: AbortSignal): Promise<any> {
    return this.callUnary("agentPresets/list" as never, {} as never, signal);
  }

  public agentPresetsSelect(
    args: { agentId: string; agentPreset: string },
    signal?: AbortSignal,
  ): Promise<any> {
    return this.callUnary("agentPresets/select" as never, { ...args } as never, signal);
  }

  public agentPresetsRead(
    args: { agentPreset: string },
    signal?: AbortSignal,
  ): Promise<any> {
    return this.callUnary("agentPresets/read" as never, { ...args } as never, signal);
  }

  public agentPresetsCopy(
    args: { from: string; id: string; name?: string },
    signal?: AbortSignal,
  ): Promise<any> {
    const payload: Record<string, unknown> = { from: args.from, id: args.id };
    if (args.name !== undefined) payload.name = args.name;
    return this.callUnary("agentPresets/copy" as never, payload as never, signal);
  }

  public agentPresetsDelete(args: { id: string }, signal?: AbortSignal): Promise<any> {
    return this.callUnary("agentPresets/deletePreset" as never, { ...args } as never, signal);
  }

  public settingsCanOpenAgentPresetDirectory(signal?: AbortSignal): Promise<any> {
    return this.callUnary("settings/canOpenAgentPresetDirectory" as never, {} as never, signal);
  }

  public settingsOpenAgentPresetDirectory(
    args: { agentPreset: string },
    signal?: AbortSignal,
  ): Promise<any> {
    return this.callUnary("settings/openAgentPresetDirectory" as never, { ...args } as never, signal);
  }
  /**
   * 21:00Z HANDOVER llm 拆分映射：旧 llm.providers 合并已删（POST /api/llm/providers→404 未 claim），
   * 新链 llm/listProviders（活路由 [{id,name}]）+ llm/listConfigurableProviders（目录
   * [{provider,displayName,settingsNs,settingsPath,declared?}]）经 join（active=注册含 route），
   * 目录 llm.models→session/modelCatalog 取 groups。信封 POST /api/<method> +
   * {type,rpcId,method,payload:{args:{}}}，仍经 Rust 代理，不直连 3080。
   */
  public llmListProviders(signal?: AbortSignal): Promise<any> {
    return this.callUnary("llm/listProviders" as never, {} as never, signal);
  }

  public llmListConfigurableProviders(signal?: AbortSignal): Promise<any> {
    return this.callUnary("llm/listConfigurableProviders" as never, {} as never, signal);
  }

  public llmDiscoverModels(
    args: { settingsNs: string; request: { provider?: string; baseURL?: string; api?: string; apiKey?: string } },
    signal?: AbortSignal,
  ): Promise<any> {
    return this.callUnary("llm/discoverModels" as never, { ...args } as never, signal);
  }

  public sessionModelCatalog(signal?: AbortSignal): Promise<any> {
    return this.callUnary("session/modelCatalog" as never, {} as never, signal);
  }
  /**
   * 23:50Z HANDOVER workspace归档：旧 flat {sessionId} 已改 wire {request:{sessionId}}，
   * 新描述符 WorkspaceArchiveSessionRequest{sessionId}，官方 archiveSession(sessionId)=>remote.archiveSession({sessionId})。
   * 信封 POST /api/workspace/archiveSession + {type,rpcId,method,payload:{args:{request:{sessionId}}}}，仍经 Rust 代理。
   */
  public workspaceArchiveSession(request: { sessionId: string }, signal?: AbortSignal): Promise<any> {
    return this.callUnary("workspace.archiveSession" as never, { request } as never, signal);
  }
  public sessionPage(
    request: {
      address:
        | { kind: "session"; sessionId: string }
        | { kind: "subagent"; parentSessionId: string; childSessionId: string; mode: "one-shot" | "continuable" };
      throughSeq: number;
      beforeSeq?: number;
      maxMessages?: number;
    },
    signal?: AbortSignal,
  ): Promise<{ rpcId: string; result: unknown }> {
    return this.callUnary("session.page" as never, { request } as never, signal);
  }

  protected override async callUnary(
    method: any,
    payload: any,
    signal?: AbortSignal,
    timeoutPolicy: "default" | "caller-signal-only" = "default",
  ): Promise<any> {
    const slash = String(method).replace(/\./g, "/");
    // stream 方法禁 unary 直调：误调即 gateway/signature-invalid（HANDOVER 17:30Z）。
    if (slash === "session/follow" || slash === "session/control") {
      throw new Error(`${slash} 为 stream 方法，禁 callUnary 直调（须走 connection.rpc.open，物理疑 /api/remote.mux，代理 WS 现仅放行 events.mux/host→跟进另单）`);
    }
    let args = payload !== null && typeof payload === "object" ? payload : {};
    // 15:30/15:31Z HANDOVER 方案A（最小改）：session/list 的 args 必含 _request:{cursor?}
    // 官方原文 client.js:1716 remote.session.list({})→wire {_request:{}}；旧包 payload={} 直包
    // 成 {args:{}} 会被 assertExactArguments 判 missing "_request"（业务 ok:false 仍 HTTP 200）。
    // 此分支把旧调用 api.sessions.list({}|{cursor}) 译为新 wire {_request:{}}（cursor 透传可选）。
    if (slash === "session/list") {
      const p = payload as Record<string, unknown> | null;
      const inner =
        p !== null && typeof p === "object" && "_request" in p
          ? (p as { _request?: unknown })._request
          : undefined;
      if (inner !== null && typeof inner === "object") {
        const cursor = (inner as { cursor?: unknown }).cursor;
        args = typeof cursor === "string" ? { _request: { cursor } } : { _request: {} };
      } else if (p !== null && typeof p === "object" && typeof (p as { cursor?: unknown }).cursor === "string") {
        args = { _request: { cursor: (p as { cursor: string }).cursor } };
      } else {
        args = { _request: {} };
      }
    } else if (slash === "session/page" || slash === "session/search") {
      // 17:30Z HANDOVER 垫片分支：page/search 的 wire 键为 request（非 _request）。
      // 新形 {request:{address,throughSeq,beforeSeq?,maxMessages?}} 直透；直接 {address,…}/{query} 包一层。
      const p = payload as Record<string, unknown> | null;
      if (p !== null && typeof p === "object" && "request" in p && p.request !== null && typeof p.request === "object") {
        args = { request: (p as { request: unknown }).request };
      } else if (p !== null && typeof p === "object" && ("address" in p || "query" in p)) {
        args = { request: { ...(p as object) } };
      } else {
        args = { request: { ...((p as object) ?? {}) } };
      }
    } else if (slash === "workspace/archiveSession") {
      // 23:50Z HANDOVER 垫片分支：wire 键为 request（WorkspaceArchiveSessionRequest{sessionId}）。
      // 新形 {request:{sessionId}} 直透；旧 flat {sessionId} 包一层（禁多键）。
      const p = payload as Record<string, unknown> | null;
      if (p !== null && typeof p === "object" && "request" in p && p.request !== null && typeof p.request === "object") {
        args = { request: (p as { request: unknown }).request };
      } else if (p !== null && typeof p === "object" && typeof (p as { sessionId?: unknown }).sessionId === "string") {
        args = { request: { sessionId: (p as unknown as { sessionId: string }).sessionId } };
      } else {
        args = { request: { ...((p as object) ?? {}) } };
      }
    }
    // 19:00Z HANDOVER 垫片：旧单数 agentPreset/* → 新复数 agentPresets/* + settings/*PresetDirectory。
    // 旧 typed 方法仍发 agentPreset.list/select/read/copy/remove/openDocument（单数 dot→slash），
    // 此处译为新复数 endpoint + 新 args 形状（copy 去 agentPreset 留 id、remove 改 deletePreset、openDocument 改径）。
    // 新 helpers 已发复数 slash，此处做归一化（sessionId→agentId 别名、agentPreset→id 别名剥离、多余键剔除，
    // 网关 assertExactArguments 对多键即 unexpected）。
    let targetSlash = slash;
    {
      const p = (args !== null && typeof args === "object" ? args : {}) as Record<string, unknown>;
      if (slash === "agentPreset/list") {
        targetSlash = "agentPresets/list";
        args = {};
      } else if (slash === "agentPreset/select") {
        targetSlash = "agentPresets/select";
        const agentId = (p.agentId ?? p.sessionId) as unknown;
        args = { agentId, agentPreset: p.agentPreset };
      } else if (slash === "agentPreset/read") {
        targetSlash = "agentPresets/read";
        args = { agentPreset: p.agentPreset };
      } else if (slash === "agentPreset/copy") {
        targetSlash = "agentPresets/copy";
        const id = (p.id ?? p.agentPreset) as unknown;
        const next: Record<string, unknown> = { from: p.from, id };
        if (p.name !== undefined) next.name = p.name;
        args = next;
      } else if (slash === "agentPreset/remove") {
        targetSlash = "agentPresets/deletePreset";
        args = { id: (p.id ?? p.agentPreset) as unknown };
      } else if (slash === "agentPreset/openDocument") {
        targetSlash = "settings/openAgentPresetDirectory";
        args = { agentPreset: p.agentPreset };
      } else if (slash === "agentPresets/list") {
        targetSlash = "agentPresets/list";
        args = {};
      } else if (slash === "agentPresets/select") {
        targetSlash = "agentPresets/select";
        const agentId = (p.agentId ?? p.sessionId) as unknown;
        args = { agentId, agentPreset: p.agentPreset };
      } else if (slash === "agentPresets/copy") {
        targetSlash = "agentPresets/copy";
        const id = (p.id ?? p.agentPreset) as unknown;
        const next: Record<string, unknown> = { from: p.from, id };
        if (p.name !== undefined) next.name = p.name;
        args = next;
      } else if (slash === "agentPresets/deletePreset") {
        targetSlash = "agentPresets/deletePreset";
        args = { id: (p.id ?? p.agentPreset) as unknown };
      } else if (slash === "agentPresets/read") {
        targetSlash = "agentPresets/read";
        args = { agentPreset: p.agentPreset };
      } else if (slash === "settings/canOpenAgentPresetDirectory") {
        targetSlash = "settings/canOpenAgentPresetDirectory";
        args = {};
      } else if (slash === "settings/openAgentPresetDirectory") {
        targetSlash = "settings/openAgentPresetDirectory";
        args = { agentPreset: p.agentPreset };
      } else if (slash === "llm/listProviders") {
        // 21:00Z HANDOVER：零参禁多键（网关 assertExactArguments），强制 args:{}。
        targetSlash = "llm/listProviders";
        args = {};
      } else if (slash === "llm/listConfigurableProviders") {
        targetSlash = "llm/listConfigurableProviders";
        args = {};
      } else if (slash === "llm/discoverModels") {
        // 21:00Z HANDOVER：旧扁平 {settingsNs,provider?,baseURL?,api?,apiKey?} 须拆出首键
        // →新形 {settingsNs,request:{provider?,baseURL?,api?,apiKey?}}；新形直透（多余键剔除）。
        targetSlash = "llm/discoverModels";
        const settingsNs = p.settingsNs as unknown;
        const nested = p.request as Record<string, unknown> | undefined;
        if (nested !== null && typeof nested === "object" && nested !== undefined) {
          const req: Record<string, unknown> = {};
          for (const k of ["provider", "baseURL", "api", "apiKey"] as const) {
            if ((nested as Record<string, unknown>)[k] !== undefined) req[k] = (nested as Record<string, unknown>)[k];
          }
          args = { settingsNs, request: req };
        } else {
          const req: Record<string, unknown> = {};
          for (const k of ["provider", "baseURL", "api", "apiKey"] as const) {
            if (p[k] !== undefined) req[k] = p[k];
          }
          args = { settingsNs, request: req };
        }
      } else if (slash === "llm/models") {
        // 21:00Z HANDOVER：旧 llm.models 已由 session/modelCatalog 超集替代（含 default+routableProviders）。
        targetSlash = "session/modelCatalog";
        args = {};
      } else if (slash === "session/modelCatalog") {
        targetSlash = "session/modelCatalog";
        args = {};
      }
    }
    const message = {
      type: "client-request" as const,
      rpcId: this.mintRpcId(),
      method: targetSlash,
      payload: { args },
    };
    this.onEnvelope(message as never);
    const path = `/api/${targetSlash}`;
    const requestSignal =
      timeoutPolicy === "default"
        ? signal === undefined
          ? AbortSignal.timeout(this.timeoutMs)
          : AbortSignal.any([AbortSignal.timeout(this.timeoutMs), signal])
        : signal;
    const response = await this.doFetch(new URL(path, this.resolveBase()), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      ...(requestSignal === undefined ? {} : { signal: requestSignal }),
    });
    if (!response.ok) {
      throw new Error(`transport failure for ${path}: HTTP ${response.status}`);
    }
    const json = await response.json();
    let full: any;
    try {
      full = serverResponseSchema.parse(json);
    } catch {
      // 新网关错误码（如 gateway/*）不在旧 rpcErrorSchema 联合体内，严格解析会误抛；
      // 回退为宽松信封校验（type/rpcId/result 形状），原始 result 透传。
      const loose = json as { type?: unknown; rpcId?: unknown; result?: unknown };
      if (
        loose.type !== "server-response" ||
        typeof loose.rpcId !== "string" ||
        typeof loose.result !== "object" ||
        loose.result === null
      ) {
        throw new Error(`invalid server-response for ${path}`);
      }
      full = loose;
    }
    this.onEnvelope(full as never);
    if (full.rpcId !== message.rpcId) {
      throw new Error(`rpcId mismatch for ${targetSlash}: sent ${String(message.rpcId)}, got ${String(full.rpcId)}`);
    }
    return { rpcId: full.rpcId, result: full.result };
  }

  protected openMux(
    _payload: Parameters<import("@deepseek-ai/dsh-host-apiproxy/api").ApiProxy["events"]["mux"]>[0]["payload"],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket(MUX_EVENTS_PATH, signal, muxFrameSchema, onOpen);
  }

  protected openHost(
    _payload: Parameters<import("@deepseek-ai/dsh-host-apiproxy/api").ApiProxy["events"]["host"]>[0]["payload"],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket(HOST_EVENTS_PATH, signal, hostFrameSchema, onOpen);
  }

  private async *readWebSocket<T>(
    path: string,
    signal: AbortSignal,
    frameSchema: Schema<T>,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<T>> {
    const url = new URL(path, this.resolveBase());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    const inbox: Array<{ kind: "frame"; envelope: RpcRequest<T> } | { kind: "end" }> = [];
    let wake: (() => void) | undefined;
    const enqueue = (item: { kind: "frame"; envelope: RpcRequest<T> } | { kind: "end" }) => {
      inbox.push(item);
      wake?.();
      wake = undefined;
    };
    const handleOpen = () => onOpen?.();
    const handleMessage = (event: MessageEvent) => {
      try {
        if (typeof event.data !== "string") throw new Error("binary WebSocket frame");
        const full = serverRequestSchema.parse(JSON.parse(event.data));
        const frame = frameSchema.parse(full.payload);
        this.onEnvelope(full);
        enqueue({ kind: "frame", envelope: { rpcId: full.rpcId, payload: frame } });
      } catch (error) {
        console.error(`[dsh-client] dropping malformed WebSocket frame on ${path}:`, error);
      }
    };
    const handleClose = () => enqueue({ kind: "end" });
    const handleAbort = () => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
    socket.addEventListener("open", handleOpen);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", handleClose, { once: true });
    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) handleAbort();
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift();
          if (!item) break;
          if (item.kind === "end") return;
          yield item.envelope;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      signal.removeEventListener("abort", handleAbort);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", handleClose);
      handleAbort();
    }
  }
}
