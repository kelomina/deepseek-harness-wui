import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ExecMode = "bundled" | "npx" | "path" | "wsl";
export type DshState = "stopped" | "starting" | "running" | "error";

export interface DshStatus {
  state: DshState;
  pid: number | null;
  port: number;
  proxy_port: number;
  message: string;
  uptime_secs: number | null;
  auto_start: boolean;
  proxy_used: string | null;
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
  proxy_enabled: boolean;
  proxy_url: string | null;
  selected_provider: string | null;
  selected_model: string | null;
  selected_reasoning: string | null;
  managed_runtime_version: string | null;
  wsl_default_distro: string | null;
  wsl_dsh_home: string | null;
  wsl_workspace_dir: string | null;
}

export interface RuntimeView {
  version: string;
  installed: boolean;
  installed_at: number | null;
  integrity: string | null;
  bin_sha256: string | null;
  active: boolean;
}

export interface VerifyReport {
  version: string;
  present: boolean;
  version_match: boolean;
  bin_exists: boolean;
  bin_hash_match: boolean;
  ok: boolean;
  detail: string;
}

export interface WslDistro {
  name: string;
  state: string;
  version: string;
  is_default: boolean;
}

export interface WslStatus {
  available: boolean;
  windows: boolean;
  default_distro: string | null;
  kernel: string | null;
  wsl_version: string | null;
  distros: WslDistro[];
  reason: string | null;
}

export interface WslProvisionStep {
  phase: string;
  status: "running" | "ok" | "warn" | "error" | "log";
  message: string;
}

export interface WslProvisionReport {
  ok: boolean;
  distro: string | null;
  user: string | null;
  node_version: string | null;
  dsh_version: string | null;
  dsh_home: string | null;
  workspace_dir: string | null;
  steps: WslProvisionStep[];
  error: string | null;
}


export interface RoutingSuiteStatus {
  injector_installed: boolean;
  injector_name: string | null;
  preset_installed: boolean;
  preset_dir: string;
  vendored_found: boolean;
  vendored_injector_ready: boolean;
  vendored_preset_ready: boolean;
  dsh_home: string;
}

/** 首启前置条件检测结果（Node + dsh 运行时）。 */
export interface PrereqCheck {
  ok: boolean;
  node_path: string | null;
  node_version: string | null;
  dsh_runtime_version: string | null;
  bundled_present: boolean;
}

export interface NodeInstallReport {
  ok: boolean;
  node_path: string | null;
  node_version: string | null;
  steps: string[];
  error: string | null;
}

export const prereq = {
  check: () => invoke<PrereqCheck>("prereq_check_cmd"),
  /** 长耗时：下载官方 Node 安装包（SHA256 校验）+ 提权静默安装（UAC/管理员密码框）。 */
  installNode: () => invoke<NodeInstallReport>("prereq_install_node_cmd"),
};

export const routingSuite = {
  status: () => invoke<RoutingSuiteStatus>("routing_suite_status_cmd"),
  install: () => invoke<string>("routing_suite_install_cmd"),
  remove: () => invoke<string>("routing_suite_remove_cmd"),
};
export const runtime = {
  list: () => invoke<RuntimeView[]>("runtime_list_cmd"),
  install: (version: string) => invoke<RuntimeView>("runtime_install_cmd", { version }),
  verify: (version: string) => invoke<VerifyReport>("runtime_verify_cmd", { version }),
  remove: (version: string) => invoke<string>("runtime_remove_cmd", { version }),
  rollback: (version: string) => invoke<string>("runtime_rollback_cmd", { version }),
  remoteVersions: () => invoke<string[]>("runtime_remote_versions_cmd"),
  setActive: (version: string | null) => invoke<void>("runtime_set_active_cmd", { version }),
};

export const wsl = {
  status: () => invoke<WslStatus>("wsl_status_cmd"),
  saveConfig: (defaultDistro: string | null, dshHome: string | null, workspaceDir: string | null) =>
    invoke<void>("wsl_save_config_cmd", { defaultDistro, dshHome, workspaceDir }),
  provision: (distro?: string | null, exactVersion?: string | null) =>
    invoke<WslProvisionReport>("wsl_provision_cmd", { distro, exactVersion }),
};

export function onWslProvision(cb: (s: WslProvisionStep) => void): Promise<() => void> {
  return listen<WslProvisionStep>("wsl://provision", (e) => cb(e.payload));
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
