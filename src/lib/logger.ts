import { useSyncExternalStore } from "react";
import { onDshLog, onWslProvision } from "./tauri";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource =
  | "dsh"
  | "runtime"
  | "proxy"
  | "ui"
  | "network"
  | "wsl"
  | "plugin"
  | "system";

export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  source: LogSource;
  message: string;
  details?: string;
}

const MAX_LOG_ENTRIES = 1000;

function formatDetails(details: unknown): string | undefined {
  if (details === undefined || details === null) return undefined;
  if (typeof details === "string") return details;
  if (details instanceof Error) {
    return details.stack || details.message;
  }
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

class LoggerStore {
  private entries: LogEntry[] = [];
  private listeners = new Set<() => void>();
  private seq = 0;
  private unreadErrors = 0;
  private initialized = false;

  constructor() {
    if (typeof window !== "undefined") {
      // guard v4 兜底网（转正，非临时）：吞“xterm 内部孤儿 timer 遗言”——gen1 open 排的
      // setTimeout→rAF 在 dispose 后仍触发，读已清空 _renderer.value 即炸，与我方守卫无关。
      // 签名精确到文件名+方法链（xterm.js 内 + dimensions + Viewport/open 路径），禁宽吞。
      const isOrphanViewportDimensions = (message: unknown, stack: unknown): boolean => {
        const msg = String(message ?? "");
        if (!msg.includes("dimensions")) return false;
        if (!/Cannot read propert|reading ['"]dimensions['"]|undefined/i.test(msg)) return false;
        const st = String(stack ?? "");
        if (!/xterm(\.js|\.mjs|\.css)?/i.test(st)) return false;
        return /get dimensions|Viewport|_innerRefresh|_refresh|syncScrollArea|RenderService|Terminal\.open/i.test(st);
      };
      const swallowOrphanDim = (message: unknown, err: unknown): boolean => {
        const stack = (err as Error | undefined)?.stack ?? err;
        if (!isOrphanViewportDimensions(message, stack)) return false;
        // eslint-disable-next-line no-console
        console.debug("[pty] guard v4: swallow orphan viewport dimensions (disposed gen1 timer)", stack ?? message);
        return true;
      };
      window.addEventListener("error", (event) => {
        if (isOrphanViewportDimensions(event.message, (event.error as Error | undefined)?.stack ?? event.error)) return;
        this.error("ui", `未捕获异常: ${event.message}`, {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: event.error,
        });
      });
      window.addEventListener(
        "error",
        (event) => {
          if (swallowOrphanDim(event.message, event.error)) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        },
        true,
      );
      window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason as Error | undefined;
        if (isOrphanViewportDimensions(reason?.message, reason?.stack ?? reason)) {
          // eslint-disable-next-line no-console
          console.debug("[pty] guard v4: swallow orphan viewport dimensions (rejection)", reason?.stack ?? reason);
          event.preventDefault();
          return;
        }
        this.error(
          "ui",
          `未处理的 Promise 异常: ${String(event.reason?.message ?? event.reason)}`,
          event.reason
        );
      });
    }
  }

  initSubscriptions(): void {
    if (this.initialized) return;
    this.initialized = true;

    // 订阅 dsh 进程原始 stdout/stderr
    void onDshLog((line) => {
      const lower = line.toLowerCase();
      const level: LogLevel =
        lower.includes("error") || lower.includes("err_") || lower.includes("fatal")
          ? "error"
          : lower.includes("warn")
          ? "warn"
          : "info";
      this.addEntry(level, "dsh", line);
    }).catch(() => {});

    // 订阅 WSL 阶段与日志
    void onWslProvision((step) => {
      const level: LogLevel =
        step.status === "error"
          ? "error"
          : step.status === "warn"
          ? "warn"
          : "info";
      this.addEntry(level, "wsl", `[${step.phase}] ${step.message}`);
    }).catch(() => {});
  }

  private addEntry(
    level: LogLevel,
    source: LogSource,
    message: string,
    rawDetails?: unknown
  ): void {
    const timestamp = Date.now();
    this.seq += 1;
    const id = `log-${timestamp}-${this.seq}`;
    const details = formatDetails(rawDetails);

    const entry: LogEntry = {
      id,
      timestamp,
      level,
      source,
      message: message.trim(),
      details,
    };

    this.entries = [...this.entries.slice(-(MAX_LOG_ENTRIES - 1)), entry];

    if (level === "error") {
      this.unreadErrors += 1;
    }

    this.listeners.forEach((fn) => fn());
  }

  debug(source: LogSource, message: string, details?: unknown): void {
    this.addEntry("debug", source, message, details);
  }

  info(source: LogSource, message: string, details?: unknown): void {
    this.addEntry("info", source, message, details);
  }

  warn(source: LogSource, message: string, details?: unknown): void {
    this.addEntry("warn", source, message, details);
  }

  error(source: LogSource, message: string, details?: unknown): void {
    this.addEntry("error", source, message, details);
  }

  getLogs = (): LogEntry[] => {
    return this.entries;
  };

  getUnreadErrors = (): number => {
    return this.unreadErrors;
  };

  clearUnreadErrors = (): void => {
    if (this.unreadErrors !== 0) {
      this.unreadErrors = 0;
      this.listeners.forEach((fn) => fn());
    }
  };

  clear = (): void => {
    this.entries = [];
    this.unreadErrors = 0;
    this.listeners.forEach((fn) => fn());
  };

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  exportText(): string {
    return this.entries
      .map((e) => {
        const time = new Date(e.timestamp).toISOString();
        const header = `[${time}] [${e.level.toUpperCase()}] [${e.source}] ${e.message}`;
        return e.details ? `${header}\n  Details: ${e.details}` : header;
      })
      .join("\n");
  }

  exportJson(): string {
    return JSON.stringify(this.entries, null, 2);
  }
}

export const logger = new LoggerStore();

export function useLogs(): LogEntry[] {
  return useSyncExternalStore(logger.subscribe, logger.getLogs);
}

export function useUnreadErrors(): number {
  return useSyncExternalStore(logger.subscribe, logger.getUnreadErrors);
}
