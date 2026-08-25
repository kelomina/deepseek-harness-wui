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
      window.addEventListener("error", (event) => {
        this.error("ui", `未捕获异常: ${event.message}`, {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: event.error,
        });
      });

      window.addEventListener("unhandledrejection", (event) => {
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
