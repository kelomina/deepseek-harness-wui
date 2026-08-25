import { useEffect, useMemo, useRef, useState } from "react";
import { logger, useLogs, type LogLevel, type LogSource } from "../lib/logger";

const LEVEL_COLORS: Record<LogLevel, string> = {
  error: "var(--red, #f87171)",
  warn: "var(--orange, #fbbf24)",
  info: "var(--blue, #60a5fa)",
  debug: "var(--text-3, #9ca3af)",
};

const SOURCE_LABELS: Record<LogSource, string> = {
  dsh: "DSH 服务",
  runtime: "运行时",
  proxy: "网络代理",
  ui: "界面/前端",
  network: "网络/API",
  wsl: "WSL 模块",
  plugin: "插件系统",
  system: "系统底层",
};

export function LogPanel({ compact = false }: { compact?: boolean }) {
  const logs = useLogs();
  const [levelFilter, setLevelFilter] = useState<LogLevel | "all">("all");
  const [sourceFilter, setSourceFilter] = useState<LogSource | "all">("all");
  const [keyword, setKeyword] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logger.clearUnreadErrors();
  }, []);

  const stats = useMemo(() => {
    let errorCount = 0;
    let warnCount = 0;
    for (const l of logs) {
      if (l.level === "error") errorCount += 1;
      else if (l.level === "warn") warnCount += 1;
    }
    return { total: logs.length, errors: errorCount, warns: warnCount };
  }, [logs]);

  const filteredLogs = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return logs.filter((entry) => {
      if (levelFilter !== "all" && entry.level !== levelFilter) return false;
      if (sourceFilter !== "all" && entry.source !== sourceFilter) return false;
      if (kw) {
        const msgMatch = entry.message.toLowerCase().includes(kw);
        const detailsMatch = entry.details?.toLowerCase().includes(kw);
        const sourceMatch = entry.source.toLowerCase().includes(kw);
        if (!msgMatch && !detailsMatch && !sourceMatch) return false;
      }
      return true;
    });
  }, [logs, levelFilter, sourceFilter, keyword]);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filteredLogs.length, autoScroll]);

  const toggleExpand = (id: string) => {
    setExpandedMap((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(`已复制 ${label}`);
      window.setTimeout(() => setCopyFeedback(null), 2000);
    } catch {
      setCopyFeedback("复制失败");
      window.setTimeout(() => setCopyFeedback(null), 2000);
    }
  };

  const exportLogFile = () => {
    const text = logger.exportText();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dsh-desktop-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatTimestamp = (ts: number) => {
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${h}:${m}:${s}.${ms}`;
  };

  return (
    <div className={`sys-log-viewer ${compact ? "compact" : ""}`}>
      {/* 头部统计与操作 */}
      <div className="log-topbar">
        <div className="log-stats">
          <span className="stat-item">共 {stats.total} 条</span>
          {stats.errors > 0 && (
            <span
              className="stat-badge error"
              onClick={() => setLevelFilter(levelFilter === "error" ? "all" : "error")}
              title="点击仅看错误"
            >
              {stats.errors} 错误
            </span>
          )}
          {stats.warns > 0 && (
            <span
              className="stat-badge warn"
              onClick={() => setLevelFilter(levelFilter === "warn" ? "all" : "warn")}
              title="点击仅看警告"
            >
              {stats.warns} 警告
            </span>
          )}
        </div>

        <div className="log-actions">
          {copyFeedback && <span className="copy-hint">{copyFeedback}</span>}
          <button
            className="btn sm"
            onClick={() => void copyToClipboard(logger.exportText(), "全部日志")}
            title="复制全部日志到剪贴板"
          >
            复制全部
          </button>
          <button className="btn sm" onClick={exportLogFile} title="导出 .log 文件">
            导出日志
          </button>
          <button className="btn sm danger-o" onClick={() => logger.clear()} title="清空所有日志">
            清空
          </button>
        </div>
      </div>

      {/* 过滤栏 */}
      <div className="log-filter-bar">
        <div className="filter-group level-pills">
          <button
            className={`pill-btn ${levelFilter === "all" ? "active" : ""}`}
            onClick={() => setLevelFilter("all")}
          >
            全部
          </button>
          <button
            className={`pill-btn error ${levelFilter === "error" ? "active" : ""}`}
            onClick={() => setLevelFilter("error")}
          >
            错误 {stats.errors > 0 ? `(${stats.errors})` : ""}
          </button>
          <button
            className={`pill-btn warn ${levelFilter === "warn" ? "active" : ""}`}
            onClick={() => setLevelFilter("warn")}
          >
            警告 {stats.warns > 0 ? `(${stats.warns})` : ""}
          </button>
          <button
            className={`pill-btn info ${levelFilter === "info" ? "active" : ""}`}
            onClick={() => setLevelFilter("info")}
          >
            信息
          </button>
          <button
            className={`pill-btn debug ${levelFilter === "debug" ? "active" : ""}`}
            onClick={() => setLevelFilter("debug")}
          >
            调试
          </button>
        </div>

        <div className="filter-group select-wrap">
          <select
            className="source-select"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.currentTarget.value as LogSource | "all")}
          >
            <option value="all">全部来源 ({logs.length})</option>
            {Object.entries(SOURCE_LABELS).map(([k, label]) => {
              const count = logs.filter((l) => l.source === k).length;
              return (
                <option key={k} value={k}>
                  {label} ({count})
                </option>
              );
            })}
          </select>
        </div>

        <div className="filter-group search-wrap">
          <input
            className="log-search-input"
            placeholder="搜索日志 / 错误详情…"
            value={keyword}
            onChange={(e) => setKeyword(e.currentTarget.value)}
          />
          {keyword && (
            <button className="search-clear-btn" onClick={() => setKeyword("")}>
              ×
            </button>
          )}
        </div>

        <label className="autoscroll-toggle" title="新日志到达时自动滚动到底部">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.currentTarget.checked)}
          />
          <span>自动滚动</span>
        </label>
      </div>

      {/* 日志内容列表 */}
      <div className="log-entries-container" ref={listRef}>
        {filteredLogs.length === 0 ? (
          <div className="log-empty-state">
            {logs.length === 0 ? "暂无系统日志" : "无符合当前筛选条件的日志"}
          </div>
        ) : (
          filteredLogs.map((entry) => {
            const isExpanded = !!expandedMap[entry.id];
            return (
              <div
                key={entry.id}
                className={`log-row log-${entry.level} ${entry.details ? "has-details" : ""}`}
              >
                <div className="log-row-main">
                  <span className="log-time">{formatTimestamp(entry.timestamp)}</span>
                  <span
                    className={`log-level-badge ${entry.level}`}
                    style={{ color: LEVEL_COLORS[entry.level] }}
                  >
                    {entry.level.toUpperCase()}
                  </span>
                  <span className="log-source-tag">[{SOURCE_LABELS[entry.source] || entry.source}]</span>
                  <span className="log-msg">{entry.message}</span>

                  <div className="log-row-ops">
                    {entry.details && (
                      <button
                        className="btn-link sm"
                        onClick={() => toggleExpand(entry.id)}
                      >
                        {isExpanded ? "收起详情" : "展开详情"}
                      </button>
                    )}
                    <button
                      className="btn-copy sm"
                      title="复制此条日志"
                      onClick={() =>
                        void copyToClipboard(
                          `[${formatTimestamp(entry.timestamp)}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}${
                            entry.details ? `\n${entry.details}` : ""
                          }`,
                          "单条日志"
                        )
                      }
                    >
                      复制
                    </button>
                  </div>
                </div>

                {entry.details && isExpanded && (
                  <div className="log-details-block">
                    <pre className="log-details-pre">{entry.details}</pre>
                    <button
                      className="btn sm subtle log-details-copy"
                      onClick={() => void copyToClipboard(entry.details!, "错误详情")}
                    >
                      复制详情
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
