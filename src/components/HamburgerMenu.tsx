import { useEffect, useRef, useState } from "react";

export type ToolTab = "files" | "terminal" | "web" | "git" | "session";

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
];

export function HamburgerMenu({
  onOpenTool,
}: {
  onOpenTool: (tab: ToolTab) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
        className="hamburger-btn"
        title="工具菜单"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="hamburger-icon" />
      </button>
      {open && (
        <div className="hamburger-menu">
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
              <span className="hm-label">{it.label}</span>
              {it.desc && <span className="hm-desc">{it.desc}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
