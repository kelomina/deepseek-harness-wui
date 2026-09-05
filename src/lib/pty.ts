import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * 真 pty 前端封装（任务#7，对应 CONTRACT 2026-09-07T06:00Z）。
 * 后端：`src-tauri/src/dsh/pty.rs`（portable-pty 0.9.0，常驻 shell）。
 * 事件统一名 + id 字段冻结：`pty-output {id,data}` / `pty-exit {id,exit_code}`。
 * 禁止拼接 `pty-output-{id}` 式事件名。
 */

/** 并发上限（与后端 MAX_PTY_SESSIONS=4 同值，前端仅做建前提示，真正 gate 在后端）。 */
export const MAX_PTY_SESSIONS = 4;

export interface PtyOutputEvent {
  id: string;
  data: string;
}

export interface PtyExitEvent {
  id: string;
  exit_code: number | null;
}

export const pty = {
  spawn: (cwd?: string | null, cols = 80, rows = 24) =>
    invoke<string>("pty_spawn", { cwd: cwd?.trim() ? cwd.trim() : null, cols, rows }),
  write: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  resize: (id: string, cols: number, rows: number) =>
    invoke<void>("pty_resize", { id, cols, rows }),
  kill: (id: string) => invoke<void>("pty_kill", { id }),
};

export function onPtyOutput(cb: (e: PtyOutputEvent) => void): Promise<() => void> {
  return listen<PtyOutputEvent>("pty-output", (e) => cb(e.payload));
}

export function onPtyExit(cb: (e: PtyExitEvent) => void): Promise<() => void> {
  return listen<PtyExitEvent>("pty-exit", (e) => cb(e.payload));
}
