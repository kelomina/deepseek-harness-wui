/**
 * Protocol client: official protocol core (AbstractApiClient from
 * @deepseek-ai/dsh-host-apiproxy/client) + official browser WebSocket
 * transport (reimplemented from the MIT-licensed WebApiClient bundle).
 *
 * All traffic targets the local Tauri proxy (127.0.0.1:<proxy_port>), which
 * strips browser Origin and forwards to dsh — required because dsh rejects
 * non-loopback Origins at /api.
 */
import { AbstractApiClient } from "@deepseek-ai/dsh-host-apiproxy/client";
import { serverRequestSchema } from "@deepseek-ai/dsh-host-apiproxy/api";
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
