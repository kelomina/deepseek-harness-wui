/**
 * policy.ts — PRD-003 v1.1 域② 策略表（纯函数，无导入，可单测）。
 *
 * 决策链（冻结，deny 优先）：
 *   完全访问禁用回退 ＞ deny 行命中（自动拒绝，永久不可放开）
 *   ＞ 工具自检（危险命令/敏感路径启发式，转人工）
 *   ＞ ask 行命中（转人工；无人值守时转拒绝）
 *   ＞ allow 行命中（自动批准，受天花板 + 边界约束）
 *   ＞ 无命中（转人工，fail-closed）
 *
 * 本文件零依赖：`npx tsc src/lib/policy.ts` 可独立编译后跑决策矩阵。
 */

export type PolicyVerdict = "allow" | "ask" | "deny";
export type PolicyEffect = PolicyVerdict;

export interface PolicyRow {
  id: string;
  group: "工具" | "文件" | "内置" | "插件" | "预设";
  effect: PolicyEffect;
  /** 命中说明（审计行 policyRowId 即此 id）。 */
  note: string;
  /** deny 行永久不可放开（冻结）。 */
  neverRelax?: boolean;
}

export interface PolicyInput {
  toolName: string;
  reason?: string;
  /** 涉及路径（文件类申请；无则为纯工具申请）。 */
  path?: string;
  /** 工作区根（边界判定用；null = 未知边界，一律按界外处理）。 */
  workspaceRoot?: string | null;
  /** 员工权限天花板快照（默认 read-only）。 */
  ceiling?: string;
  /** 当前默认预设值（danger-full-access 即“完全访问”，本轮禁用）。 */
  preset?: string | null;
  /** host.describe.canOpenPath（申请时刻复查）。 */
  canOpenPath?: boolean;
  /** 无人值守：ask 一律转拒绝（dont_ask-headless 语义）。 */
  unattended?: boolean;
}

export interface PolicyDecision {
  verdict: PolicyVerdict;
  rowId: string;
  detail: string;
}

export const POLICY_ROWS: PolicyRow[] = [
  { id: "preset-full-access-disabled", group: "预设", effect: "ask", note: "完全访问本轮禁用：选即回退，转人工" },
  { id: "deny-outside-workspace", group: "文件", effect: "deny", note: "工作区外/系统路径读写", neverRelax: true },
  { id: "deny-credential-path", group: "文件", effect: "deny", note: "~/.dsh/凭据路径及疑似密钥参数", neverRelax: true },
  { id: "deny-settings-provider-credentials", group: "内置", effect: "deny", note: "settings.mutate/replace 提供商/凭据命名空间", neverRelax: true },
  { id: "deny-system-path", group: "文件", effect: "deny", note: "系统路径（Windows/Program Files/盘根等）", neverRelax: true },
  { id: "selfcheck-danger", group: "工具", effect: "ask", note: "工具自检：危险命令/敏感路径启发式，转人工" },
  { id: "ask-write-inside", group: "工具", effect: "ask", note: "工作区内写（SQUAD 并行默认 ask 防冲突）" },
  { id: "ask-term", group: "工具", effect: "ask", note: "终端执行（破坏性一律先问）" },
  { id: "ask-web-fetch", group: "工具", effect: "ask", note: "外网抓取" },
  { id: "ask-plugin-grant", group: "插件", effect: "ask", note: "plugin_host 非空授权必审（空即拒）" },
  { id: "allow-read-inside", group: "工具", effect: "allow", note: "工作区内读" },
  { id: "allow-term-readonly", group: "工具", effect: "allow", note: "终端只读命令" },
  { id: "allow-subagent-prompt", group: "内置", effect: "allow", note: "subagent.prompt 派生" },
  { id: "no-match-fail-closed", group: "工具", effect: "ask", note: "无命中转人工（fail-closed）" },
  { id: "ask-unattended-deny", group: "预设", effect: "deny", note: "无人值守时 ask 转拒绝" },
  { id: "deny-ceiling-insufficient", group: "预设", effect: "deny", note: "员工天花板不足（read-only 遇写）" },
  { id: "deny-canopen-false", group: "文件", effect: "deny", note: "canOpenPath=false 复查未通过" },
];

const DANGER_CMD = [
  "rm -rf", "mkfs", "format ", "del /f /s", "rd /s", "drop database", "drop table",
  ":(){:|:&};:", "shutdown", "takeown", "cipher /w", "vssadmin delete",
];

const WRITE_TOOLS = ["edit", "write", "apply_patch", "file_write", "fs_write"];
const READ_TOOLS = ["read", "file_read", "fs_read", "search", "grep", "glob", "list"];
const READONLY_TERM = ["dir", "ls", "cat", "type ", "echo", "git status", "git log", "git diff", "pwd", "whoami"];

function lower(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").trim().toLowerCase();
}

function looksLikeCredential(text: string): boolean {
  const t = lower(text);
  return (
    t.includes(".dsh") ||
    t.includes(".credentials.yaml") ||
    t.includes("api_key") ||
    t.includes("apikey") ||
    t.includes("sk-") ||
    t.includes("secret") ||
    t.includes("private_key")
  );
}

function looksLikeSystemPath(p: string): boolean {
  const n = norm(p);
  return (
    n.startsWith("c:/windows") ||
    n.startsWith("c:/program files") ||
    n.startsWith("c:/programdata") ||
    /^[a-z]:\/$/.test(n) ||
    n === "c:" ||
    n.startsWith("/etc") ||
    n.startsWith("/sys") ||
    n.startsWith("/proc")
  );
}

function outsideWorkspace(path: string, root: string | null | undefined): boolean {
  if (!root) return true;
  const n = norm(path);
  if (n.startsWith("//wsl$/")) return true;
  const r = norm(root).replace(/\/+$/, "");
  return !(n === r || n.startsWith(`${r}/`));
}

/**
 * 纯决策函数：deny 优先链，无命中 fail-closed，完全访问禁用回退，ask 无人值守转拒绝。
 */
export function decideApproval(input: PolicyInput): PolicyDecision {
  const tool = lower(input.toolName);
  const reason = input.reason ?? "";
  const path = input.path;
  const ceiling = lower(input.ceiling ?? "read-only");

  // 1) 完全访问禁用回退（选即回退，转人工；永不放行）。
  if (input.preset === "danger-full-access" || input.preset === "完全访问") {
    return { verdict: "ask", rowId: "preset-full-access-disabled", detail: "完全访问已被 PRD 禁用，已回退为询问审批" };
  }

  // 2) deny 行（永久不可放开；deny 压过 allow）。
  if (path) {
    if (looksLikeCredential(path) || looksLikeCredential(reason)) {
      return { verdict: "deny", rowId: "deny-credential-path", detail: "命中凭据路径/疑似密钥参数 deny 行" };
    }
    if (looksLikeSystemPath(path)) {
      return { verdict: "deny", rowId: "deny-system-path", detail: "命中系统路径 deny 行" };
    }
    if (outsideWorkspace(path, input.workspaceRoot ?? null)) {
      return { verdict: "deny", rowId: "deny-outside-workspace", detail: "工作区外路径，命中 deny 行" };
    }
  } else if (looksLikeCredential(reason)) {
    return { verdict: "deny", rowId: "deny-credential-path", detail: "reason 含疑似密钥参数，命中 deny 行" };
  }
  if (tool.includes("settings.mutate") || tool.includes("settings.replace") || tool === "settings") {
    if (/provider|credential|secret|api[_-]?key/i.test(reason)) {
      return { verdict: "deny", rowId: "deny-settings-provider-credentials", detail: "settings 提供商/凭据命名空间，命中 deny 行" };
    }
  }
  if (input.canOpenPath === false) {
    return { verdict: "deny", rowId: "deny-canopen-false", detail: "canOpenPath=false，边界复查未通过" };
  }

  // 3) 工具自检：危险命令/敏感路径启发式 → 转人工。
  const hay = `${tool} ${lower(reason)}`;
  if (DANGER_CMD.some((d) => hay.includes(d))) {
    return { verdict: "ask", rowId: "selfcheck-danger", detail: "危险命令启发式命中，转人工" };
  }

  // 4) ask 行命中（无人值守转拒绝）。
  const askHit: string | null =
    tool.includes("plugin") && tool.includes("grant")
      ? "ask-plugin-grant"
      : tool.includes("term") || tool.includes("exec") || tool.includes("pwsh") || tool.includes("bash") || tool.includes("shell")
        ? (READONLY_TERM.some((c) => hay.includes(c)) ? null : "ask-term")
        : tool.includes("web_fetch") || tool.includes("fetch") || tool.includes("websearch")
          ? "ask-web-fetch"
          : WRITE_TOOLS.some((t) => tool.includes(t))
            ? "ask-write-inside"
            : null;
  if (askHit) {
    if (input.unattended) {
      return { verdict: "deny", rowId: "ask-unattended-deny", detail: `${askHit} 在无人值守下转拒绝` };
    }
    return { verdict: "ask", rowId: askHit, detail: `命中 ask 行 ${askHit}` };
  }

  // 5) allow 行命中（受天花板 + 边界约束；天花板不足即拒）。
  const allowHit: string | null =
    READ_TOOLS.some((t) => tool.includes(t)) || tool === "read"
      ? "allow-read-inside"
      : tool.includes("subagent")
        ? "allow-subagent-prompt"
        : READONLY_TERM.some((c) => hay.includes(c))
          ? "allow-term-readonly"
          : null;
  if (allowHit) {
    const needsWrite = WRITE_TOOLS.some((t) => tool.includes(t));
    if (needsWrite && ceiling === "read-only") {
      return { verdict: "deny", rowId: "deny-ceiling-insufficient", detail: "read-only 天花板遇写操作，自动拒绝" };
    }
    return { verdict: "allow", rowId: allowHit, detail: `命中 allow 行 ${allowHit}` };
  }

  // 6) 无命中 → 转人工（fail-closed）。
  if (input.unattended) {
    return { verdict: "deny", rowId: "ask-unattended-deny", detail: "无命中 + 无人值守，转拒绝" };
  }
  return { verdict: "ask", rowId: "no-match-fail-closed", detail: "无策略命中，fail-closed 转人工" };
}

/** 决策矩阵自测（deny 压 allow / 越界 deny / 凭据 deny / 无命中转人工 / 完全访问禁用）。失败抛错。 */
export function assertPolicyMatrix(): string[] {
  const cases: Array<{ name: string; input: PolicyInput; want: PolicyVerdict; wantRow?: string }> = [
    {
      name: "deny压allow（工作区外read仍拒绝）",
      input: { toolName: "read", path: "C:/Windows/System32/drivers/etc/hosts", workspaceRoot: "E:/repo" },
      want: "deny",
    },
    {
      name: "越界deny（工作区外写）",
      input: { toolName: "write", path: "D:/other/notes.txt", workspaceRoot: "E:/repo" },
      want: "deny",
      wantRow: "deny-outside-workspace",
    },
    {
      name: "凭据deny（~/.dsh 路径）",
      input: { toolName: "read", path: "C:/Users/x/.dsh/.credentials.yaml", workspaceRoot: "C:/Users/x/.dsh" },
      want: "deny",
      wantRow: "deny-credential-path",
    },
    {
      name: "凭据deny（reason 含假密钥）",
      input: { toolName: "read", reason: "api_key=sk-fake1234567890", workspaceRoot: "E:/repo" },
      want: "deny",
      wantRow: "deny-credential-path",
    },
    {
      name: "无命中转人工（fail-closed）",
      input: { toolName: "mystery_tool_xyz", workspaceRoot: "E:/repo" },
      want: "ask",
      wantRow: "no-match-fail-closed",
    },
    {
      name: "完全访问禁用回退（选即转人工）",
      input: { toolName: "read", preset: "danger-full-access", workspaceRoot: "E:/repo" },
      want: "ask",
      wantRow: "preset-full-access-disabled",
    },
    {
      name: "工作区内读自动批准",
      input: { toolName: "read", path: "E:/repo/src/a.ts", workspaceRoot: "E:/repo" },
      want: "allow",
    },
    {
      name: "ask无人值守转拒绝",
      input: { toolName: "web_fetch", workspaceRoot: "E:/repo", unattended: true },
      want: "deny",
      wantRow: "ask-unattended-deny",
    },
  ];
  const passed: string[] = [];
  for (const c of cases) {
    const d = decideApproval(c.input);
    if (d.verdict !== c.want || (c.wantRow && d.rowId !== c.wantRow)) {
      throw new Error(`矩阵失败[${c.name}]：期望 ${c.want}${c.wantRow ? `/${c.wantRow}` : ""}，实际 ${d.verdict}/${d.rowId}`);
    }
    passed.push(`${c.name} → ${d.verdict}/${d.rowId}`);
  }
  return passed;
}
