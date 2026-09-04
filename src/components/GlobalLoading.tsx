import { useEffect, useRef, useState } from "react";
import {
  REASSURE_TEXT,
  cancelAllCancellable,
  cancelLoading,
  useGlobalLoading,
  type LoadingProgressReserved,
} from "../lib/loading";

/**
 * PRD-002 全局 Loading 覆盖层（DESIGN-SYSTEM-loading §3 冻结结构）。
 * class 名冻结：loading-mask / loading-card / loading-row / loading-spinner /
 * loading-text / loading-title / loading-stage / loading-sub /
 * loading-bar / loading-bar-fill / loading-actions / loading-details。
 * indeterminate 必备；determinate 仅预留（本轮恒 null，禁假百分比）。
 */
export function GlobalLoading() {
  const tasks = useGlobalLoading();
  const [flash, setFlash] = useState(false);
  const maskRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  const open = tasks.length > 0;
  const multi = tasks.length > 1;
  const primary = tasks[0];
  // progressReserved 本轮恒 null（FR-L04 预留占位，不渲染 determinate）。
  const progressReserved: LoadingProgressReserved = {
    progress: null,
    loadedBytes: null,
    totalBytes: null,
    eventField: null,
  };
  void progressReserved;

  const title = !open ? "" : multi ? `正在执行 ${tasks.length} 项任务…` : primary.title;
  const stage = !open ? "" : multi ? `${primary.stage}（共${tasks.length}项）` : primary.stage;
  const elapsedSec = !open ? 0 : Math.max(...tasks.map((t) => t.elapsedSec));
  const cancellable = !open ? false : multi ? tasks.some((t) => t.cancellable) : primary.cancellable;
  const cancelReason = !open
    ? null
    : multi
      ? tasks.every((t) => !t.cancellable)
        ? tasks[0].cancelReason
        : null
      : primary.cancelReason;
  const details = !open ? [] : multi ? tasks.flatMap((t) => [`【${t.title}】${t.stage}`, ...t.details]).slice(-80) : [...primary.details];
  const isProvision = !open ? false : multi ? false : primary.command === "wsl_provision_cmd";
  const cancelText = isProvision ? "最小化观察，后台继续，禁重入" : "取消";

  // 焦点 进→锁→还（FR-L08 冻结）。
  useEffect(() => {
    if (open && !wasOpen.current) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      // 首启 SetupWizard 双 modal 叠加时：触发源即向导按钮，落点仍为覆盖层标题/取消，
      // 不抢向导文本输入焦点（安装任务均为不可取消组，落点为标题 tabindex=-1）。
      const t = window.setTimeout(() => {
        if (cancellable) cancelRef.current?.focus();
        else titleRef.current?.focus();
      }, 0);
      wasOpen.current = true;
      return () => window.clearTimeout(t);
    }
    if (!open && wasOpen.current) {
      wasOpen.current = false;
      const el = triggerRef.current;
      triggerRef.current = null;
      if (el && document.contains(el)) {
        try {
          el.focus();
        } catch {
          // ignore
        }
      }
    }
    return undefined;
  }, [open, cancellable]);

  // Tab 陷阱 + Esc 矩阵（可取消=取消，不可取消=outline+tooltip，兼容 reduced-motion 无位移动画）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (cancellable) {
          e.preventDefault();
          if (multi) cancelAllCancellable();
          else if (primary) cancelLoading(primary.key);
        } else {
          e.preventDefault();
          setFlash(true);
          window.setTimeout(() => setFlash(false), 1200);
        }
        return;
      }
      if (e.key !== "Tab" || !maskRef.current) return;
      const root = maskRef.current;
      const items = [...root.querySelectorAll<HTMLElement>("button:not(:disabled), summary, [tabindex]")].filter(
        (el) => el.tabIndex >= 0 && el.offsetParent !== null,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, cancellable, multi, primary]);

  if (!open || !primary) return null;

  const handleCancel = (): void => {
    if (!cancellable) {
      setFlash(true);
      window.setTimeout(() => setFlash(false), 1200);
      return;
    }
    if (multi) cancelAllCancellable();
    else cancelLoading(primary.key);
  };

  return (
    <div
      ref={maskRef}
      className="loading-mask"
      role="dialog"
      aria-modal="true"
      aria-live="polite"
      aria-labelledby="loading-title"
      aria-describedby="loading-stage loading-sub"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className={`loading-card${flash ? " flash-outline" : ""}`} role="document">
        <div className="loading-row">
          <div className="loading-spinner" aria-hidden="true" />
          <div className="loading-text">
            <div id="loading-title" ref={titleRef} className="loading-title" tabIndex={-1}>
              {title}
            </div>
            <div id="loading-stage" className="loading-stage" aria-live="polite">
              {stage}
            </div>
            <div id="loading-sub" className="loading-sub">
              已等待 {elapsedSec}s · {REASSURE_TEXT}
            </div>
          </div>
        </div>
        <div className="loading-bar" aria-hidden="true">
          <div className="loading-bar-fill" />
        </div>
        <div className="loading-actions">
          {cancellable ? (
            <button ref={cancelRef} className="btn sm" data-action="cancel" onClick={handleCancel}>
              {cancelText}
            </button>
          ) : (
            <button
              ref={cancelRef}
              className="btn sm"
              data-action="cancel"
              disabled
              title={cancelReason ?? undefined}
              onClick={handleCancel}
            >
              {cancelText}
            </button>
          )}
        </div>
        {details.length > 0 && (
          <details className="loading-details">
            <summary>详情</summary>
            <pre>{details.join("\n")}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
