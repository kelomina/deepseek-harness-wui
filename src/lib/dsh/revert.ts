/**
 * Revert/retract boundary computation (devContext items 10/11).
 *
 * dsh 0.1.0-rc.6 协议不支持「当前会话内撤回」（sessions API 仅有
 * list/search/create/history/models/selectModel/rename/fork/prompt/attachment/
 * updateQueue/cancel）。「撤回/重试」在协议层降级为 fork：以该消息之前的
 * 轮次边界（prevTurnEnd）为 atSeq 新建会话。本模块计算该边界与该轮的文件
 * diff（用于可选的文件回退），并可从会话历史事件独立验证。
 */
export interface RevertDiff {
  seq: number;
  oldText: string | null;
  newText: string;
}

export interface RevertFile {
  path: string;
  diffs: RevertDiff[];
}

export interface RevertInfo {
  /** 该消息之前的最后一个 turn/end seq；null 表示这是首条消息，无法回退。 */
  prevTurnEnd: number | null;
  files: RevertFile[];
}

interface EventLike {
  seq: number;
  event: { type: string; seq: number };
  view?: { view?: { diffs?: Array<{ path: string; oldText: string | null; newText: string }> } };
}

/**
 * 计算撤回边界：
 * - prevTurnEnd = 位于目标消息之前的最后一个 turn/end（fork 的 atSeq 锚点）。
 * - files = 目标消息所在轮（prevTurnEnd 之后）内 tool/result 携带的 diff，按 seq 升序。
 */
export function computeRevertInfo(events: EventLike[], seq: number): RevertInfo {
  let prevTurnEnd: number | null = null;
  for (const raw of events) {
    if (raw.event.type === "turn/end" && raw.event.seq < seq) prevTurnEnd = raw.event.seq;
  }
  const files = new Map<string, { path: string; diffs: RevertDiff[] }>();
  if (prevTurnEnd !== null) {
    for (const raw of events) {
      if (raw.event.seq <= prevTurnEnd) continue;
      if (raw.event.type !== "tool/result") continue;
      const diffs = raw.view?.view?.diffs;
      if (!diffs) continue;
      for (const d of diffs) {
        const f = files.get(d.path) ?? { path: d.path, diffs: [] };
        f.diffs.push({ seq: raw.event.seq, oldText: d.oldText, newText: d.newText });
        files.set(d.path, f);
      }
    }
  }
  return { prevTurnEnd, files: [...files.values()] };
}
