import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ExecMode = "bundled" | "npx" | "path";
export type DshState = "stopped" | "starting" | "running" | "error";

export interface DshStatus {
  state: DshState;
  pid: number | null;
  port: number;
  proxy_port: number;
  message: string;
  uptime_secs: number | null;
  auto_start: boolean;
}

export interface DshConfig {
  exec_mode: ExecMode;
  exec_path: string | null;
  port: number;
  dsh_home: string | null;
  workspace_dir: string | null;
  auto_start: boolean;
  startup_timeout_secs: number;
  max_restarts: number;
  restart_window_secs: number;
  health_interval_secs: number;
  log_max_lines: number;
}

export const dsh = {
  status: () => invoke<DshStatus>("dsh_status"),
  start: () => invoke<void>("dsh_start"),
  stop: () => invoke<void>("dsh_stop"),
  getConfig: () => invoke<DshConfig>("dsh_get_config"),
  setConfig: (config: DshConfig) => invoke<void>("dsh_set_config", { config }),
  getLogs: (limit?: number) => invoke<string[]>("dsh_get_logs", { limit }),
};

export function onDshStatus(cb: (s: DshStatus) => void): Promise<() => void> {
  return listen<DshStatus>("dsh://status", (e) => cb(e.payload));
}

export function onDshLog(cb: (line: string) => void): Promise<() => void> {
  return listen<string>("dsh://log", (e) => cb(e.payload));
}
