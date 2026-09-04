import { useSyncExternalStore } from "react";
import { appStore } from "./dsh/store";
import { logger } from "./logger";

/**
 * PRD-002 v1.1 全局 Loading 包装层（纯前端，不新增 invoke/事件）。
 * 真相源：.agents/contracts/PRD-loading.md §4 + API-SPEC-loading.yaml。
 * dsh 口径锁定 0.1.1-rc.2，不改后端 Rust。
 */

// === 冻结常量（PRD FR-L01/FR-L07，集中单一表，禁止散落硬编码） ===
export const LOADING_THRESHOLD_MS = 800;
export const MIN_VISIBLE_MS = 500;
export const LOADING_Z_INDEX = 500;
export const DEFAULT_SINGLE_TASK_SECS = 60;
export const WEB_FETCH_FRONTEND_SECS = 25;
// 冻结区间 120–180s：取上限 180s 防慢网误杀（npm 下载）。
export const RUNTIME_INSTALL_SECS = 180;
export const ROUTING_SUITE_INSTALL_SECS = 180;
export const WSL_PROVISION_INVOKE_SECS = 600;
export const PREREQ_INSTALL_NODE_SECS = 600;
export const PROVISION_EVENT_STALL_WARN_SECS = 120;

export const DEDUP_TOAST = "任务进行中，请稍候";
export const REASSURE_TEXT = "软件运行正常，请稍候";
export const CANCEL_TOOLTIP =
  "此阶段不可取消：中断将导致安装树损坏/后台照执行，需重装/需复验";
export const WSL_PROVISION_WAIT_TEXT = "最小化观察，后台继续，禁重入";
export const TIMEOUT_SUFFIX = "软件未卡死，任务超时";

/** PRD-002 v1.1 §FR-L04 预留：本轮一律 null，仅占位 */
export interface LoadingProgressReserved {
  progress: number | null;
  loadedBytes?: number | null;
  totalBytes?: number | null;
  eventField?: string | null;
}

export interface LoadingTaskView {
  key: string;
  command: string;
  title: string;
  stage: string;
  details: string[];
  elapsedSec: number;
  cancellable: boolean;
  cancelReason: string | null;
}

interface InternalTask extends LoadingTaskView {
  startAt: number;
  visibleAt: number | null;
  lastReportAt: number;
  stallWarned: boolean;
  abort: AbortController;
}

export interface WithLoadingOpts {
  /** 参与去重的 args（默认 null）。key = command + JSON(args)。 */
  args?: unknown;
  /** 初始阶段（默认按 PRD §4.3 词表推导，不允许脑补新阶段名）。 */
  stage?: string;
  timeoutSecs?: number;
  cancellable?: boolean;
  details?: string[];
  /** 为 true 时成功不弹 toast（默认 false；仅 overlay 曾出现时才 toast）。 */
  silentSuccess?: boolean;
}

export class LoadingCancelledError extends Error {
  constructor(msg = "已取消等待（后端照执行，已忽略结果）") {
    super(msg);
    this.name = "LoadingCancelledError";
  }
}
export class LoadingDedupError extends Error {
  constructor(msg: string = DEDUP_TOAST) {
    super(msg);
    this.name = "LoadingDedupError";
  }
}
export class LoadingTimeoutError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LoadingTimeoutError";
  }
}

export function isCancelError(e: unknown): boolean {
  return e instanceof LoadingCancelledError;
}
export function isDedupError(e: unknown): boolean {
  return e instanceof LoadingDedupError;
}
export function isTimeoutError(e: unknown): boolean {
  return e instanceof LoadingTimeoutError;
}

// === 取消矩阵（API-SPEC-loading.yaml 冻结，取消=前端 Abort 中止等待+忽略结果，后端照跑） ===
const CANCELLABLE = new Set<string>([
  "runtime_remote_versions_cmd",
  "runtime_list_cmd",
  "runtime_verify_cmd",
  "desktop_check_update_cmd",
  "wsl_status_cmd",
  "routing_suite_status_cmd",
  "plugins_list_cmd",
  "plugins_list",
  "prereq_check_cmd",
  "dsh_status",
  "dsh_get_config",
  "dsh_get_logs",
  "dsh_get_log_file_path_cmd",
  "fs_list_dir",
  "git_status",
  "git_diff_file",
  "preset_package_preview_cmd",
  "web_fetch",
  "plugin_host_logs_cmd",
  "desktop_get_lan_pairing_cmd",
]);

export function isCancellable(command: string): boolean {
  return CANCELLABLE.has(command);
}

export function getCancelReason(command: string): string | null {
  if (isCancellable(command)) return null;
  if (command === "wsl_provision_cmd") return WSL_PROVISION_WAIT_TEXT;
  return CANCEL_TOOLTIP;
}

export function getTimeoutSecs(command: string): number {
  if (command === "web_fetch") return WEB_FETCH_FRONTEND_SECS;
  if (command === "runtime_install_cmd") return RUNTIME_INSTALL_SECS;
  if (command === "routing_suite_install_cmd") return ROUTING_SUITE_INSTALL_SECS;
  if (command === "wsl_provision_cmd") return WSL_PROVISION_INVOKE_SECS;
  if (command === "prereq_install_node_cmd") return PREREQ_INSTALL_NODE_SECS;
  return DEFAULT_SINGLE_TASK_SECS;
}

/** PRD §4.3 冻结词表首阶段（实现时不允许脑补新阶段名）。 */
export function getInitialStage(command: string): string {
  if (
    command === "runtime_remote_versions_cmd" ||
    command === "desktop_check_update_cmd"
  )
    return "正在连接源…";
  if (command === "runtime_install_cmd" || command === "routing_suite_install_cmd")
    return "正在下载…";
  if (
    command === "prereq_install_node_cmd" ||
    command === "runtime_set_active_cmd" ||
    command === "runtime_remove_cmd" ||
    command === "runtime_rollback_cmd" ||
    command === "routing_suite_remove_cmd" ||
    command === "wsl_provision_cmd" ||
    command === "wsl_save_config_cmd"
  )
    return "正在准备…";
  if (command === "web_fetch" || command === "term_exec") return "正在收集…";
  // 加载类默认
  return "正在检测…";
}

export function buildLoadingKey(command: string, args?: unknown): string {
  return `${command}:${JSON.stringify(args ?? null)}`;
}

// === 全局状态（Map<command+args, AbortController> 去重 + 可见层） ===
const inflight = new Map<string, AbortController>();
const visible = new Map<string, InternalTask>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot(): LoadingTaskView[] {
  return [...visible.values()].map((t) => ({
    key: t.key,
    command: t.command,
    title: t.title,
    stage: t.stage,
    details: [...t.details],
    elapsedSec: t.elapsedSec,
    cancellable: t.cancellable,
    cancelReason: t.cancelReason,
  }));
}

let snapshotCache: LoadingTaskView[] = [];
function getSnapshot(): LoadingTaskView[] {
  return snapshotCache;
}
function refreshSnapshot(): void {
  snapshotCache = snapshot();
  notify();
}

export function useGlobalLoading(): LoadingTaskView[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 取消单个在途任务（仅可取消组有效）：中止等待 + 忽略结果，不杀后端。 */
export function cancelLoading(key: string): void {
  const c = inflight.get(key);
  if (c && !c.signal.aborted) c.abort();
}

/** 取消全部可取消任务（Esc / N 并行时用）。 */
export function cancelAllCancellable(): void {
  for (const [key, task] of visible) {
    if (task.cancellable) cancelLoading(key);
  }
}

function toastNotice(text: string, ms = 3000): void {
  try {
    appStore.setNotice(text);
    window.setTimeout(() => {
      try {
        if (appStore.get().notice === text) appStore.setNotice(null);
      } catch {
        // ignore
      }
    }, ms);
  } catch {
    // ignore (store 不可用时不阻断业务)
  }
}

// 1s 心跳：刷新耗时 + provision 事件停滞 warn（纯前端，不新增事件）。
if (typeof window !== "undefined") {
  window.setInterval(() => {
    if (visible.size === 0) return;
    const now = Date.now();
    let changed = false;
    for (const t of visible.values()) {
      const sec = Math.floor((now - t.startAt) / 1000);
      if (sec !== t.elapsedSec) {
        t.elapsedSec = sec;
        changed = true;
      }
      if (
        t.command === "wsl_provision_cmd" &&
        !t.stallWarned &&
        now - t.lastReportAt > PROVISION_EVENT_STALL_WARN_SECS * 1000
      ) {
        t.stallWarned = true;
        t.details = [
          ...t.details.slice(-49),
          `事件停滞超过${PROVISION_EVENT_STALL_WARN_SECS}s，后台仍在继续…${REASSURE_TEXT}`,
        ];
        logger.warn("wsl", `wsl_provision 事件停滞超过${PROVISION_EVENT_STALL_WARN_SECS}s，后台仍在继续`, {
          key: t.key,
        });
        changed = true;
      }
    }
    if (changed) refreshSnapshot();
  }, 1000);
}

export type LoadingReport = (stage: string, detailLine?: string) => void;

/**
 * invoke 包装器：800ms 阈值防抖 + 500ms 最小停留 + 全局去重 + 超时 + Abort 忽略。
 * 严禁在此新增 invoke 字段；阶段文案与 PRD §4.3 逐字一致；禁假百分比。
 */
export async function withLoading<T>(
  command: string,
  title: string,
  fn: (signal: AbortSignal, report: LoadingReport) => Promise<T>,
  opts?: WithLoadingOpts,
): Promise<T> {
  const key = buildLoadingKey(command, opts?.args);
  if (inflight.has(key)) {
    toastNotice(DEDUP_TOAST);
    throw new LoadingDedupError(DEDUP_TOAST);
  }
  const abort = new AbortController();
  inflight.set(key, abort);
  const startAt = Date.now();
  const cancellable = opts?.cancellable ?? isCancellable(command);
  const cancelReason = cancellable ? null : getCancelReason(command);
  const task: InternalTask = {
    key,
    command,
    title,
    stage: opts?.stage ?? getInitialStage(command),
    details: [...(opts?.details ?? [])],
    elapsedSec: 0,
    cancellable,
    cancelReason,
    startAt,
    visibleAt: null,
    lastReportAt: startAt,
    stallWarned: false,
    abort,
  };
  const report: LoadingReport = (stage, detailLine) => {
    task.stage = stage;
    task.lastReportAt = Date.now();
    if (detailLine) task.details = [...task.details.slice(-99), detailLine];
    if (task.visibleAt !== null) refreshSnapshot();
  };

  const timeoutSecs = opts?.timeoutSecs ?? getTimeoutSecs(command);
  let showTimer: number | undefined = window.setTimeout(() => {
    if (!inflight.has(key)) return;
    task.visibleAt = Date.now();
    task.elapsedSec = Math.floor((Date.now() - startAt) / 1000);
    visible.set(key, task);
    refreshSnapshot();
  }, LOADING_THRESHOLD_MS);

  let timeoutTimer: number | undefined = window.setTimeout(() => {
    if (!inflight.has(key)) return;
    abort.abort();
  }, timeoutSecs * 1000);

  const clearTimers = (): void => {
    if (showTimer !== undefined) {
      window.clearTimeout(showTimer);
      showTimer = undefined;
    }
    if (timeoutTimer !== undefined) {
      window.clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
  };

  const hideAfterMinStay = async (wasVisible: boolean, visibleAt: number | null): Promise<void> => {
    if (!wasVisible || visibleAt === null) return;
    const stay = Date.now() - visibleAt;
    if (stay < MIN_VISIBLE_MS) {
      await new Promise((r) => window.setTimeout(r, MIN_VISIBLE_MS - stay));
    }
    visible.delete(key);
    refreshSnapshot();
  };

  try {
    const result = await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        // 超时 vs 手动取消：以后到者为准；超时文案必须含指定短语
        const elapsed = Math.floor((Date.now() - startAt) / 1000);
        if (elapsed >= timeoutSecs) {
          reject(
            new LoadingTimeoutError(
              `${title}：${TIMEOUT_SUFFIX}（已等待${elapsed}s，超时${timeoutSecs}s），可重试或查看日志`,
            ),
          );
        } else {
          reject(new LoadingCancelledError());
        }
      };
      abort.signal.addEventListener("abort", onAbort, { once: true });
      void fn(abort.signal, report).then(
        (v) => {
          abort.signal.removeEventListener("abort", onAbort);
          if (abort.signal.aborted) {
            // 后端照跑到底，前端仅忽略结果（不写状态）
            reject(new LoadingCancelledError());
          } else {
            resolve(v);
          }
        },
        (e) => {
          abort.signal.removeEventListener("abort", onAbort);
          if (abort.signal.aborted && !(e instanceof LoadingTimeoutError)) {
            const elapsed = Math.floor((Date.now() - startAt) / 1000);
            if (elapsed >= timeoutSecs) {
              reject(
                new LoadingTimeoutError(
                  `${title}：${TIMEOUT_SUFFIX}（已等待${elapsed}s，超时${timeoutSecs}s），可重试或查看日志`,
                ),
              );
            } else {
              reject(new LoadingCancelledError());
            }
          } else {
            reject(e);
          }
        },
      );
    });

    const wasVisible = visible.has(key);
    const at = task.visibleAt;
    clearTimers();
    inflight.delete(key);
    await hideAfterMinStay(wasVisible, at);
    if (wasVisible && !opts?.silentSuccess) {
      const doneText = title.endsWith("…") ? `${title.slice(0, -1)}完成` : `${title}完成`;
      toastNotice(doneText);
      logger.info("ui", doneText);
    } else {
      logger.info("ui", `${title}完成`);
    }
    return result;
  } catch (e) {
    const wasVisible = visible.has(key);
    const at = task.visibleAt;
    clearTimers();
    inflight.delete(key);
    await hideAfterMinStay(wasVisible, at);
    if (e instanceof LoadingDedupError || e instanceof LoadingCancelledError) throw e;
    if (e instanceof LoadingTimeoutError) {
      logger.error("ui", String((e as Error).message), e);
      throw e;
    }
    logger.error("ui", `${title}失败: ${String(e)}`, e);
    throw e;
  } finally {
    if (showTimer !== undefined) window.clearTimeout(showTimer);
    if (timeoutTimer !== undefined) window.clearTimeout(timeoutTimer);
    if (inflight.get(key) === abort) inflight.delete(key);
  }
}
