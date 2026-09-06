import { useEffect, useRef, useState } from "react";
import { useUnreadErrors } from "../lib/logger";
import { HM_DEFAULT, HM_MAX, HM_MIN, HM_WIDTH_KEY, useResizableWidth } from "../lib/panelResize";

export type ToolTab = "files" | "terminal" | "web" | "git" | "session" | "logs";

interface MenuItem {
  id: ToolTab;
  label: string;
  desc?: string;
  icon?: string;
}

const DEFAULT_ITEMS: MenuItem[] = [
  { id: "files", label: "文件管理器", desc: "浏览本地目录和会话涉及文件", icon: "📁" },
  { id: "terminal", label: "终端（命令行）", desc: "查看会话终端执行记录", icon: "⌨" },
  { id: "web", label: "浏览器", desc: "查看网络搜索和网页抓取记录", icon: "🌐" },
  { id: "git", label: "Git", desc: "查看会话中的文件变更 diff", icon: "⎇" },
  { id: "logs", label: "系统日志", desc: "查看应用、DSH、运行时与错误日志", icon: "📋" },
];

export function HamburgerMenu({
  onOpenTool,
}: {
  onOpenTool: (tab: ToolTab) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unreadErrors = useUnreadErrors();
  // 任务#6：汉堡面板左侧把手调宽（与侧边栏同一套 pointer 把手逻辑，clamp 另取面板语义）
  const { width: menuWidth, setWidth: setMenuWidth, startDrag: startMenuDrag, onKey: onMenuKey } =
    useResizableWidth(HM_WIDTH_KEY, HM_DEFAULT, HM_MIN, HM_MAX);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="hamburger-wrap" ref={ref}>
      <button
        className={`hamburger-btn ${unreadErrors > 0 ? "has-err" : ""}`}
        title={unreadErrors > 0 ? `工具菜单 (${unreadErrors} 个新错误)` : "工具菜单"}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="hamburger-icon" />
        {unreadErrors > 0 && <span className="hm-badge">{unreadErrors}</span>}
      </button>
      {open && (
        <div className="hamburger-menu hamburger-resizable" style={{ width: menuWidth }}>
          <div
            className="hm-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整工具菜单宽度"
            title="拖动调整宽度（双击恢复默认）"
            tabIndex={0}
            onPointerDown={(e) => {
              e.stopPropagation();
              startMenuDrag(e, -1);
            }}
            onKeyDown={(e) => onMenuKey(e, -1)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setMenuWidth(HM_DEFAULT);
            }}
          />
          {DEFAULT_ITEMS.map((it) => (
            <button
              key={it.id}
              className="hm-item"
              onClick={() => {
                setOpen(false);
                onOpenTool(it.id);
              }}
            >
              <span className="hm-icon" aria-hidden>{it.icon}</span>
              <span className="hm-label">
                {it.label}
                {it.id === "logs" && unreadErrors > 0 && (
                  <span className="badge-count error">{unreadErrors}</span>
                )}
              </span>
              {it.desc && <span className="hm-desc">{it.desc}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
