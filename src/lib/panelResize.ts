import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

// 任务#5+#6 共用把手逻辑：同一套 pointer 拖拽 + clamp + localStorage（复用 hiddenPresets 的 JSON+try/catch 模式）
// 纯前端，无 invoke；拖拽期间 body user-select 置 none 防文本选中。
export const SIDEBAR_WIDTH_KEY = "sidebarWidth";
export const SIDEBAR_HIDDEN_KEY = "sidebarHidden";
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 264; // 沿用 design.css .sidebar 现有 264px 语义

export const HM_WIDTH_KEY = "hamburgerMenuWidth";
export const HM_MIN = 200; // 沿用 .hamburger-menu 现有 min-width:200px 语义
export const HM_MAX = 420;
export const HM_DEFAULT = 280;

export const TD_WIDTH_KEY = "toolDockWidth";
export const TD_MIN = 280;
export const TD_MAX = 600;
export const TD_DEFAULT = 320; // 沿用 .tool-dock 现有 width:320px 语义

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function loadWidth(key: string, def: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return def;
    const n = JSON.parse(raw) as unknown;
    if (typeof n !== "number" || Number.isNaN(n)) return def;
    return clamp(Math.round(n), min, max);
  } catch {
    return def;
  }
}

export function useResizableWidth(key: string, def: number, min: number, max: number) {
  const [width, setWidthState] = useState<number>(() => loadWidth(key, def, min, max));
  const widthRef = useRef<number>(width);
  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const setWidth = useCallback(
    (v: number) => {
      const next = clamp(Math.round(v), min, max);
      widthRef.current = next;
      setWidthState(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* 配额/隐私模式下忽略，与 hiddenPresets 同策略 */
      }
    },
    [key, min, max],
  );

  // dir=+1：右侧把手（右移变宽，如侧边栏）；dir=-1：左侧把手（左移变宽，如右锚定汉堡面板）
  const startDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>, dir: 1 | -1) => {
      e.preventDefault();
      const el = e.currentTarget;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 旧环境无 capture 则退化为 window 监听 */
      }
      const startX = e.clientX;
      const startW = widthRef.current;
      const prevSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      const onMove = (ev: PointerEvent) => {
        const next = clamp(Math.round(startW + (ev.clientX - startX) * dir), min, max);
        widthRef.current = next;
        setWidthState(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.userSelect = prevSelect;
        try {
          window.localStorage.setItem(key, JSON.stringify(widthRef.current));
        } catch {
          /* ignore */
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [key, min, max],
  );

  const onKey = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>, dir: 1 | -1) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = e.key === "ArrowRight" ? 8 : -8;
        setWidth(widthRef.current + step * dir);
      } else if (e.key === "Home") {
        e.preventDefault();
        setWidth(min);
      } else if (e.key === "End") {
        e.preventDefault();
        setWidth(max);
      }
    },
    [min, max, setWidth],
  );

  const reset = useCallback(() => setWidth(def), [def, setWidth]);

  return { width, setWidth, startDrag, onKey, reset };
}

export function loadHidden(key: string): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return false;
    return (JSON.parse(raw) as unknown) === true;
  } catch {
    return false;
  }
}

export function saveHidden(key: string, v: boolean): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
