/**
 * devContext item 4: DeepSeek-V4-Pro 思维链降智检测（启发式提示）。
 *
 * 边界：
 * - 仅当会话显示/请求模型可识别为 DeepSeek-V4-Pro 时启用检测。
 * - 模型可识别性（V4-Pro 出现在 llm.models / session.models.current 的 id/displayName）
 *   在本项目当前锁定 dsh 0.1.0-rc.6 上需 spike 实证；未确认前按假设处理（见 docs/RISKS.md）。
 * - 正则规则可配置（localStorage），默认规则保守，避免高误报。
 * - 提示非阻断：不阻断对话、不改变模型路由、不构成模型身份结论。
 */

/** 默认保守规则（可配置）。命中表示「思维链可能异常」，不是模型身份结论。 */
export const DEFAULT_COT_RULES: string[] = [
  // 中文高频模板化开头/重复占位
  "(?:好的|好的，|好的 我来|首先|我们|接下来).{0,12}(?:分析|解决|处理|回答|进行).{0,20}(?:这个问题|这个任务|需求|问题)",
  // 中文"让我……"式模板化开头（低质量推理信号）
  "(?:让我|让我来|让我先).{0,14}(?:想想|分析|梳理|整理|确认|看看|考虑).{0,16}(?:一下|这个|一下这|清楚|一下这个问题)",
  // 中文思维链中出现「我不能」式拒绝/绕行且伴随自我指涉模板
  "我不能(?:直接|完全|提供|给出|告诉).{0,24}(?:建议|答案|结果|内容)",
  // 英文高频模板化开头（Let's / Let me）
  "(?:Let's|Let me|Let me first|Alright,? let's|Okay,? let's|Sure,? let me).{0,18}(?:think|analyze|look|figure|sort|walk|break|review|start).{0,18}(?:about|this|through|down|through this)",
  // 英文拒绝/绕行模板
  "I (?:can't|cannot|can not|am not able to|am unable to).{0,24}(?:directly|fully|completely|exactly).{0,24}(?:provide|give|offer|share|deliver).{0,24}(?:answer|solution|result|content|advice)",
];

export interface CotDetectConfig {
  enabled: boolean;
  rules: string[];
}

export function loadCotConfig(): CotDetectConfig {
  try {
    const raw = window.localStorage.getItem("cotDetect");
    if (raw) {
      const parsed = JSON.parse(raw) as { enabled?: boolean; rules?: string[] };
      return {
        enabled: parsed.enabled ?? true,
        rules: Array.isArray(parsed.rules) && parsed.rules.length > 0 ? parsed.rules : [...DEFAULT_COT_RULES],
      };
    }
  } catch {
    // ignore
  }
  return { enabled: true, rules: [...DEFAULT_COT_RULES] };
}

export function saveCotConfig(cfg: CotDetectConfig): void {
  try {
    window.localStorage.setItem("cotDetect", JSON.stringify(cfg));
  } catch {
    // ignore
  }
}

/** 模型可识别性（启发式，假设口径）：id 或 displayName 含 deepseek-v4-pro（允许 -xxx 后缀）。 */
export function isV4ProModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const m = modelId.trim().toLowerCase();
  return m === "deepseek-v4-pro" || m.startsWith("deepseek-v4-pro-") || m.startsWith("deepseek-v4-pro/") || m.includes("/deepseek-v4-pro");
}

/**
 * 检测思维链是否命中任一规则。任一规则命中即返回 true（触发非阻断提示）。
 * 空 reasoning 或空规则时不触发。
 */
export function detectCoTAnomaly(reasoning: string | null | undefined, rules: string[]): boolean {
  if (!reasoning || reasoning.trim().length === 0) return false;
  for (const rule of rules) {
    const trimmed = rule.trim();
    if (!trimmed) continue;
    try {
      const re = new RegExp(trimmed, "iu");
      if (re.test(reasoning)) return true;
    } catch {
      // 非法正则跳过（配置错误不应影响会话）
      continue;
    }
  }
  return false;
}

/** 保守提示措辞（不构成模型身份结论、不暗示确定性故障）。 */
export const COT_WARNING_TEXT =
  "检测到当前思维链可能异常，存在被路由到低质量模型或生成质量下降的可能。该提示为启发式判断，不代表模型身份结论。";

export const COT_DISCLAIMER =
  "本检测为本地启发式正则（可配置），仅作提示：不阻断对话、不改变模型路由、不构成模型身份结论。模型可识别性（V4-Pro 出现在模型目录/会话元数据）需按 docs/RISKS.md 的 spike 结论为准。";
