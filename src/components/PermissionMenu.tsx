import { useEffect, useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import type { SessionId } from "@deepseek-ai/dsh-session/types";

function titleCase(value: string): string {
  return value
    .split("-")
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join(" ");
}

/**
 * 会话权限（permission preset）菜单：弹出层向上展开，点击外部 / Esc 关闭。
 *
 * dsh 对浏览器（apiproxy）暴露的权限接口是 `permission` settings 命名空间（默认权限，
 * 新会话生效）；切换「当前会话」权限是宿主侧 `/permission` 命令（Typert commands.execute，
 * 外部客户端不可调用）。因此本菜单：
 * - 有 sessionId：标签显示该会话当前权限（permissions 投影）；选择将写入默认权限（新会话生效）。
 * - 无 sessionId（新建任务页）：直接设置默认权限。
 */
export function PermissionMenu({ sessionId }: { sessionId?: SessionId }) {
  const { sessionPermissions } = useAppState();
  const [open, setOpen] = useState(false);
  const [defaultOptions, setDefaultOptions] = useState<Array<{ value: string; name: string; description?: string }>>([]);
  const [defaultCurrent, setDefaultCurrent] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      void appStore.getPermissionOptions().then((r) => {
        setDefaultOptions(r.options);
        setDefaultCurrent(r.current);
      });
    }
  }, [open]);

  const sessionPerm = sessionId ? sessionPermissions.get(sessionId) : undefined;
  const options = sessionPerm?.options?.length ? sessionPerm.options : defaultOptions;
  const sessionCurrent = sessionPerm?.currentValue ?? null;
  const current = sessionId ? (sessionCurrent ?? defaultCurrent) : defaultCurrent;
  const label = sessionId ? `权限 · ${titleCase(sessionCurrent ?? "?")}` : current ? titleCase(current) : "权限";

  const choose = (value: string) => {
    void appStore.setDefaultPermissionPreset(value);
    setOpen(false);
  };

  return (
    <div className="env-btn perm-menu" onClick={() => setOpen((v) => !v)}>
      <span>{label}</span>
      <span className="caret">▾</span>
      {open && (
        <>
          <div className="pop-close" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className="perm-pop" onClick={(e) => e.stopPropagation()}>
            <div className="agent-pop-h">
              {sessionId
                ? `当前会话权限：${titleCase(sessionCurrent ?? "?")}。选择将设为「未来新会话」的默认权限（切换当前会话需 dsh 的 /permission 命令，外部客户端暂不可调用）。`
                : "设置未来新会话的默认权限（立即生效）"}
            </div>
            {options.map((o) => (
              <div key={o.value} className={`preset-row${o.value === sessionCurrent ? " selected" : ""}${o.value === "danger-full-access" ? " locked" : ""}`} title={o.value === "danger-full-access" ? "完全访问已被 PRD-003 禁用（选即回退）" : undefined} onClick={() => choose(o.value)}>
                <span className="preset-meta">
                  <span className="preset-nm">
                    {titleCase(o.name || o.value)}
                    {o.value === sessionCurrent && <span className="badge def">当前</span>}
                    {o.value === defaultCurrent && o.value !== sessionCurrent && <span className="badge off">默认</span>}
                    {o.value === "danger-full-access" && <span className="badge cond">已禁用</span>}
                  </span>
                  {o.description && <span className="preset-ds">{o.description}</span>}
                </span>
              </div>
            ))}
            {options.length === 0 && <div className="muted" style={{ padding: "8px 10px" }}>加载中…</div>}
          </div>
        </>
      )}
    </div>
  );
}
