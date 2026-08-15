import type { SessionSummary } from "@deepseek-ai/dsh-host-apiproxy/api";

/**
 * 会话标题：读会话投影的 `title` 单元（dsh 会话标题投影；user 源手动重命名优先）。
 * 注意结构是 `projections.values.title`（插件注册投影），不是 `projections.<key>.value`。
 */
export function sessionTitle(s: SessionSummary): string | null {
  const values = s.projections?.values as Record<string, unknown> | undefined;
  const title = values?.title;
  return typeof title === "string" && title ? title : null;
}

/**
 * 展示标题：本地标题表优先（重命名后立即生效；冷会话 `sessions.list` 无投影时兜底），
 * 其次读投影；都没有返回 null（由调用方回退到会话 id 前缀）。
 */
export function displayTitle(
  s: SessionSummary,
  localTitles?: Record<string, string>,
): string | null {
  const local = localTitles?.[s.sessionId];
  return local || sessionTitle(s);
}
