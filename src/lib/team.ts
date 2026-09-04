/**
 * team.ts — PRD-003 v1.1 域① 黑板聚合底座（纯前端，不新增 invoke / 事件）。
 *
 * - Employee 一等实体：前端本地 1:N 归属表（localStorage），会话→员工 1:1，双归属拒绝，移交留痕。
 * - 六岗角色模板：默认天花板 read-only，默认禁止含 发布/合并/删库/碰凭据。
 * - SQUAD_MAX_PARALLEL = 4；clientTaskId 去重 Map（内存 + localStorage 双作用域）。
 * - 路径归一化（大小写不敏感 + UNC/长路径 + Junction 思想：只判最终目标）+ canOpenPath 双查门禁。
 * - 审批超时 60s：置顶 + notice，不自动批。审计 reason 脱敏 ****，禁存密钥明文。
 * - 经 Rust 代理复用现 invoke；前端禁直连 dsh；凭据零存储。
 */

export const SQUAD_MAX_PARALLEL = 4;
export const APPROVAL_TIMEOUT_SECS = 60;
export const TRACE_MAX_ROWS = 100;

const EMP_KEY = "teamEmployees";
const TASK_KEY = "teamClientTaskIds";
const AUDIT_KEY = "teamAuditRows"; // 仅内存镜像键（内存为准，不做落盘承诺）
const ARRIVAL_KEY = "teamApprovalArrivals";

export type EmployeeStatus = "idle" | "running" | "awaiting" | "blocked" | "done";
export type RoleId = "frontend" | "backend" | "qa" | "pm" | "data" | "content" | "custom";

export interface HandoverRecord {
  sessionId: string;
  fromEmployeeId: string | null;
  toEmployeeId: string;
  at: number;
  reason: string;
}

export interface ForkLink {
  sessionId: string;
  fromSessionId: string;
  atSeq: number;
}

export interface Employee {
  id: string;
  name: string;
  avatar: string;
  bio: string;
  role: RoleId;
  sessionIds: string[];
  workspaceId: string | null;
  skillSnapshot: string[];
  /** 创建时 defaultPreset 快照（权限天花板），默认 read-only。 */
  ceiling: string;
  status: EmployeeStatus;
  createdAt: number;
  forkFrom: ForkLink[];
  handover: HandoverRecord[];
}

export interface RoleTemplate {
  id: RoleId;
  name: string;
  persona: string;
  methods: [string, string, string];
  defaultSkills: string[];
  defaultCeiling: string;
  forbidden: string[];
}

const BASE_FORBIDDEN = ["禁止发布到生产", "禁止合并主分支", "禁止删库/批量删除", "禁止触碰凭据与密钥"];

export const ROLE_TEMPLATES: RoleTemplate[] = [
  { id: "frontend", name: "前端", persona: "像素级还原与可用性优先的界面工程师", methods: ["先读设计 token 再写样式", "交互必给 Loading/Error/Empty 三态", "改动前后截图留证"], defaultSkills: [], defaultCeiling: "read-only", forbidden: [...BASE_FORBIDDEN] },
  { id: "backend", name: "后端", persona: "契约先行、数据可回滚的服务端工程师", methods: ["先冻结接口契约再实现", "写操作必须可回滚", "敏感操作二次确认"], defaultSkills: [], defaultCeiling: "read-only", forbidden: [...BASE_FORBIDDEN] },
  { id: "qa", name: "测试", persona: "专挑毛病的红队审查员，拥有一票否决", methods: ["先复现再定级", "拒绝把 smoke 当通过证据", "回归必须显式逐项"], defaultSkills: [], defaultCeiling: "read-only", forbidden: [...BASE_FORBIDDEN] },
  { id: "pm", name: "产品", persona: "定义边界与验收标准的产品经理", methods: ["目标可验收才算数", "范围变更走评审", "不直接写代码"], defaultSkills: [], defaultCeiling: "read-only", forbidden: [...BASE_FORBIDDEN] },
  { id: "data", name: "数据分析", persona: "用数字说话、只读优先的数据分析师", methods: ["先看口径再下结论", "只读查询优先", "结论附数据来源"], defaultSkills: [], defaultCeiling: "read-only", forbidden: [...BASE_FORBIDDEN] },
  { id: "content", name: "内容运营", persona: "讲人话、守底线的中文内容运营", methods: ["先列大纲再成稿", "引用必须可查", "敏感表述宁缺毋滥"], defaultSkills: [], defaultCeiling: "read-only", forbidden: [...BASE_FORBIDDEN] },
  { id: "custom", name: "自定义", persona: "自定义岗位（创建时填写人设）", methods: ["遵守团队禁止事项", "高风险动作转人工", "留痕可审计"], defaultSkills: [], defaultCeiling: "read-only", forbidden: [...BASE_FORBIDDEN] },
];

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储失败不阻断（内存继续可用）
  }
}

export function loadEmployees(): Employee[] {
  return readJson<Employee[]>(EMP_KEY, []);
}

export function saveEmployees(list: Employee[]): void {
  writeJson(EMP_KEY, list);
}

export function employeeBySession(list: Employee[], sessionId: string): Employee | null {
  return list.find((e) => e.sessionIds.includes(sessionId)) ?? null;
}

export function createEmployee(input: {
  name: string;
  role: RoleId;
  workspaceId?: string | null;
  sessionIds?: string[];
  ceilingSnapshot?: string;
}): { ok: true; employee: Employee } | { ok: false; error: string } {
  const list = loadEmployees();
  const sessionIds = input.sessionIds ?? [];
  for (const sid of sessionIds) {
    const owner = employeeBySession(list, sid);
    if (owner) return { ok: false, error: `会话 ${sid.slice(0, 8)} 已归属员工「${owner.name}」，双归属被拒（需先移交）` };
  }
  const tpl = ROLE_TEMPLATES.find((t) => t.id === input.role) ?? ROLE_TEMPLATES[ROLE_TEMPLATES.length - 1];
  const now = Date.now();
  const emp: Employee = {
    id: `emp-${now.toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`,
    name: input.name.trim() || tpl.name,
    avatar: input.name.trim().slice(0, 1) || tpl.name.slice(0, 1),
    bio: tpl.persona,
    role: tpl.id,
    sessionIds: [...sessionIds],
    workspaceId: input.workspaceId ?? null,
    skillSnapshot: [...tpl.defaultSkills],
    ceiling: input.ceilingSnapshot ?? tpl.defaultCeiling,
    status: "idle",
    createdAt: now,
    forkFrom: [],
    handover: [],
  };
  saveEmployees([...list, emp]);
  return { ok: true, employee: emp };
}

/** 显式移交：会话从一个员工转到另一个员工，全程留痕。 */
export function transferSession(
  sessionId: string,
  toEmployeeId: string,
  reason: string,
): { ok: true } | { ok: false; error: string } {
  const list = loadEmployees();
  const to = list.find((e) => e.id === toEmployeeId);
  if (!to) return { ok: false, error: "目标员工不存在" };
  const from = employeeBySession(list, sessionId);
  if (from && from.id === toEmployeeId) return { ok: false, error: "会话已在该员工名下，无需移交" };
  const rec: HandoverRecord = { sessionId, fromEmployeeId: from ? from.id : null, toEmployeeId, at: Date.now(), reason };
  const next = list.map((e) => {
    if (from && e.id === from.id) return { ...e, sessionIds: e.sessionIds.filter((s) => s !== sessionId) };
    if (e.id === toEmployeeId) {
      return { ...e, sessionIds: [...e.sessionIds, sessionId], handover: [...e.handover, rec] };
    }
    return e;
  });
  saveEmployees(next);
  return { ok: true };
}

/** 归档自解绑：归档会话自动解绑并留痕（reason 固定前缀便于审计检索）。 */
export function unbindSession(sessionId: string, reason = "归档自动解绑"): boolean {
  const list = loadEmployees();
  const owner = employeeBySession(list, sessionId);
  if (!owner) return false;
  saveEmployees(
    list.map((e) =>
      e.id === owner.id
        ? { ...e, sessionIds: e.sessionIds.filter((s) => s !== sessionId), handover: [...e.handover, { sessionId, fromEmployeeId: e.id, toEmployeeId: e.id, at: Date.now(), reason }] }
        : e,
    ),
  );
  return true;
}

/** fork 派生标注：新会话记“派生自 <短id>@<seq>”。 */
export function noteFork(newSessionId: string, fromSessionId: string, atSeq: number): void {
  const list = loadEmployees();
  const owner = employeeBySession(list, fromSessionId);
  if (!owner) return;
  saveEmployees(
    list.map((e) =>
      e.id === owner.id
        ? {
            ...e,
            sessionIds: e.sessionIds.includes(newSessionId) ? e.sessionIds : [...e.sessionIds, newSessionId],
            forkFrom: [...e.forkFrom, { sessionId: newSessionId, fromSessionId, atSeq }],
          }
        : e,
    ),
  );
}

export function forkLabel(list: Employee[], sessionId: string): string | null {
  for (const e of list) {
    const f = e.forkFrom.find((x) => x.sessionId === sessionId);
    if (f) return `派生自 ${f.fromSessionId.slice(0, 8)}@${f.atSeq}`;
  }
  return null;
}

/** 会话权限天花板：按归属反查员工快照，无归属默认 read-only（最小权限）。 */
export function ceilingForSession(sessionId: string): string {
  const owner = employeeBySession(loadEmployees(), sessionId);
  return owner?.ceiling ?? "read-only";
}

/* ---------------- 任务卡（FR-T102 拆解卡，前端本地） ---------------- */

export type TaskStatus = "todo" | "running" | "review" | "passed" | "rejected";

export interface TaskCard {
  clientTaskId: string;
  title: string;
  inputScope: string;
  outputTo: string;
  forbidden: string;
  approvalNote: string;
  assigneeEmployeeId: string;
  status: TaskStatus;
  evidence?: { sessionId: string; seq: number };
  createdAt: number;
}

const TASK_CARDS_KEY = "teamTaskCards";
const taskDedup = new Map<string, number>();

export function listTaskCards(): TaskCard[] {
  return readJson<TaskCard[]>(TASK_CARDS_KEY, []);
}

/**
 * 幂等派单：同 clientTaskId 重发直接拒绝（内存 Map + localStorage 双作用域）。
 * true = 本次领取成功可分派；false = 重复（调用方 toast notice）。
 */
export function claimClientTaskId(clientTaskId: string): boolean {
  if (taskDedup.has(clientTaskId)) return false;
  const persisted = readJson<string[]>(TASK_KEY, []);
  if (persisted.includes(clientTaskId)) {
    taskDedup.set(clientTaskId, Date.now());
    return false;
  }
  taskDedup.set(clientTaskId, Date.now());
  writeJson(TASK_KEY, [...persisted, clientTaskId].slice(-500));
  return true;
}

export function addTaskCard(card: Omit<TaskCard, "createdAt">): { ok: true } | { ok: false; error: string } {
  if (!claimClientTaskId(card.clientTaskId)) return { ok: false, error: "同卡重发被拒（clientTaskId 去重）" };
  const list = listTaskCards();
  writeJson(TASK_CARDS_KEY, [...list, { ...card, createdAt: Date.now() }]);
  return { ok: true };
}

export function setTaskStatus(clientTaskId: string, status: TaskStatus, evidence?: TaskCard["evidence"]): void {
  writeJson(
    TASK_CARDS_KEY,
    listTaskCards().map((c) => (c.clientTaskId === clientTaskId ? { ...c, status, evidence: evidence ?? c.evidence } : c)),
  );
}

/* ---------------- 路径归一化（Windows 三则，FR-T105） ---------------- */

/** 归一化：反斜杠→斜杠，去 UNC/长路径前缀，大小写折叠，词法消解 ./..。 */
export function normalizeTeamPath(p: string): string {
  let s = p.replace(/\\/g, "/").trim();
  s = s.replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//i, "//").replace(/^\/\/\.\//i, "//");
  // \\wsl$\ 发行版路径统一打标为界外候选（跨发行版默认视为界外）
  s = s.replace(/^\/\/wsl\$/i, "//wsl$");
  const parts: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const drive = parts.length > 0 && /^[a-zA-Z]:$/.test(parts[0]) ? parts.shift()!.toLowerCase() : "";
  const unc = !drive && s.startsWith("//") ? "/" : ""; // UNC 前导 // 保留（//wsl$ 界外判定依赖）
  return `${drive}/${unc}${parts.join("/").toLowerCase()}`;
}

/** 工作区外判定（大小写不敏感比较；\\wsl$\ 跨发行版默认界外）。 */
export function isOutsideWorkspace(path: string, workspaceRoot: string | null): boolean {
  if (!workspaceRoot) return true;
  const n = normalizeTeamPath(path);
  if (n.startsWith("//wsl$/")) return true;
  const r = normalizeTeamPath(workspaceRoot);
  return !(n === r || n.startsWith(`${r}/`));
}

const CRED_HINTS = [".dsh", ".credentials.yaml", "credentials", "api_key", "apikey", "secret", "passwd", "private_key"];

export function isCredentialPath(path: string): boolean {
  const n = normalizeTeamPath(path);
  return CRED_HINTS.some((h) => n.includes(h));
}

/** canOpenPath 双查门禁：绑定时刻 + 申请时刻均须为 true，否则显式徽标禁绑/转人工。 */
export function canBindPath(canOpenPath: boolean): boolean {
  return canOpenPath === true;
}

/* ---------------- 脱敏（审计 **** 红线） ---------------- */

const SECRET_PAIRS = [
  /(api[_-]?key\s*[:=]\s*)(["']?)[^\s"'&;]+(["']?)/gi,
  /(secret\s*[:=]\s*)(["']?)[^\s"'&;]+(["']?)/gi,
  /(token\s*[:=]\s*)(["']?)[^\s"'&;]+(["']?)/gi,
  /(password\s*[:=]\s*)(["']?)[^\s"'&;]+(["']?)/gi,
  /(sk-[A-Za-z0-9_-]{8,})/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PAIRS) {
    out = out.replace(re, (_m, p1?: string, p2?: string, p3?: string) => {
      if (p1 !== undefined) return `${p1}${p2 ?? ""}****${p3 ?? ""}`;
      return "****";
    });
  }
  // 用户主目录 Username 打码（防路径泄露即身份泄露）
  out = out.replace(/C:\/users\/[^/]+/gi, "C:/users/****");
  return out;
}

/* ---------------- 审计（内存为准 + 手动导出，不承诺落盘） ---------------- */

export type AuditVerdict = "auto-allow" | "auto-deny" | "to-human" | "human-decided" | "expired";
export type AuditSource = "dsh-approval" | "plugin-admit";

export interface AuditRow {
  requestId: string;
  source: AuditSource;
  verdict: AuditVerdict;
  policyRowId: string;
  ceiling: string;
  decidedAt: number;
  evidence: { sessionId: string; seq?: number; rpcId?: string };
  /** 已脱敏 reason（****），禁存密钥明文。 */
  reasonRedacted: string;
  rollbackPtr?: string;
}

const auditRows: AuditRow[] = [];
const approvalArrivals = new Map<string, number>();

try {
  for (const r of readJson<AuditRow[]>(AUDIT_KEY, [])) auditRows.push(r);
} catch {
  // ignore
}

export function pushAuditRow(row: AuditRow): void {
  auditRows.unshift(row);
  if (auditRows.length > 500) auditRows.length = 500;
  writeJson(AUDIT_KEY, auditRows.slice(0, 200));
}

export function listAuditRows(): AuditRow[] {
  return [...auditRows];
}

export function markHumanDecided(requestId: string): void {
  const i = auditRows.findIndex((r) => r.requestId === requestId);
  if (i >= 0) {
    auditRows[i] = { ...auditRows[i], verdict: "human-decided", decidedAt: Date.now() };
    writeJson(AUDIT_KEY, auditRows.slice(0, 200));
  }
}

export function noteApprovalArrival(approvalId: string, at = Date.now()): void {
  approvalArrivals.set(approvalId, at);
  try {
    const raw = readJson<Record<string, number>>(ARRIVAL_KEY, {});
    raw[approvalId] = at;
    writeJson(ARRIVAL_KEY, raw);
  } catch {
    // ignore
  }
}

export function approvalArrivedAt(approvalId: string): number | null {
  return approvalArrivals.get(approvalId) ?? readJson<Record<string, number>>(ARRIVAL_KEY, {})[approvalId] ?? null;
}

/** 超时仍为待判（置顶 + notice，不自动批）。 */
export function isApprovalTimedOut(approvalId: string, now = Date.now()): boolean {
  const at = approvalArrivedAt(approvalId);
  if (at === null) return false;
  return now - at >= APPROVAL_TIMEOUT_SECS * 1000;
}

export function exportAuditJson(): void {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), rows: auditRows }, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `team-audit-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- 插件 admit 待审注册表（B 源，内存） ---------------- */

export interface PendingPluginAdmit {
  pluginId: string;
  manifestName: string;
  requestedPermissions: string[];
  arrivedAt: number;
}

const pendingAdmits: PendingPluginAdmit[] = [];

export function registerPluginAdmit(a: Omit<PendingPluginAdmit, "arrivedAt">): void {
  const i = pendingAdmits.findIndex((p) => p.pluginId === a.pluginId);
  const row: PendingPluginAdmit = { ...a, arrivedAt: Date.now() };
  if (i >= 0) pendingAdmits[i] = row;
  else pendingAdmits.push(row);
}

export function listPendingAdmits(): PendingPluginAdmit[] {
  return [...pendingAdmits];
}

export function resolvePluginAdmit(pluginId: string): void {
  const i = pendingAdmits.findIndex((p) => p.pluginId === pluginId);
  if (i >= 0) pendingAdmits.splice(i, 1);
}

export function shortTeamId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}
