import type { ReactNode } from "react";

export function Badge({
  tone,
  children,
}: {
  tone?: "ok" | "err" | "warn" | "brand";
  children: ReactNode;
}) {
  return (
    <span className={`badge${tone ? ` ${tone}` : ""}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

export function Card({ title, children, extra }: { title?: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="card">
      {title && (
        <h2 style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {title}
          {extra}
        </h2>
      )}
      {children}
    </section>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <header>{title}</header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const shown = message.length > 400 ? `${message.slice(0, 400)}…（已截断，详见日志）` : message;
  return (
    <div className="error-banner" title={message}>
      <span>{shown}</span>
      <button className="btn sm subtle" onClick={onDismiss}>关闭</button>
    </div>
  );
}

export function formatTime(ms: number | undefined): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

export function shortId(id: string): string {
  return id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id;
}

