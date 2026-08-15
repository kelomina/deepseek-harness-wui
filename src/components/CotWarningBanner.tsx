import { useEffect, useMemo, useState } from "react";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { appStore } from "../lib/dsh/store";
import { COT_WARNING_TEXT, detectCoTAnomaly, isV4ProModel, loadCotConfig } from "../lib/dsh/cotDetect";

/**
 * devContext item 4: DeepSeek-V4-Pro 思维链降智检测提示（非阻断）。
 * - 仅当会话模型可识别为 V4-Pro（session.models.current，启发式）时启用。
 * - 命中可配置正则规则时显示保守措辞警告。
 * - 不阻断对话、不改变模型路由、不构成模型身份结论；可关闭。
 */
export function CotWarningBanner({ sessionId, reasoning }: { sessionId: SessionId; reasoning: string }) {
  const [modelId, setModelId] = useState<string | null>(null);
  const [modelChecked, setModelChecked] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const cfg = useMemo(() => loadCotConfig(), []);

  useEffect(() => {
    let alive = true;
    setModelChecked(false);
    setDismissed(false);
    void appStore.getSessionModelId(sessionId).then((id) => {
      if (!alive) return;
      setModelId(id);
      setModelChecked(true);
    });
    return () => { alive = false; };
  }, [sessionId]);

  if (dismissed || !cfg.enabled || !modelChecked || !modelId || !isV4ProModel(modelId)) return null;
  if (!detectCoTAnomaly(reasoning, cfg.rules)) return null;

  return (
    <div className="cot-warning" role="status">
      <span className="cot-warning-icon">⚠️</span>
      <span className="cot-warning-text">{COT_WARNING_TEXT}</span>
      <button className="btn sm subtle" onClick={() => setDismissed(true)}>知道了</button>
    </div>
  );
}
