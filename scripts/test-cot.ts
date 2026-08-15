/**
 * devContext item 4 样本评估：默认规则在标注样本上的误报/漏报统计。
 * 仅用于记录评估数据，不构成模型身份结论。
 */
import { DEFAULT_COT_RULES, detectCoTAnomaly, isV4ProModel } from "../src/lib/dsh/cotDetect.ts";

// 标注样本：positive = 应触发（低质量思维链模式）；negative = 不应触发（正常思维链）
const samples: Array<{ label: string; reasoning: string; expected: boolean }> = [
  {
    label: "neg-normal-reasoning",
    expected: false,
    reasoning:
      "用户要求重构这个模块。先读当前实现，识别重复逻辑，然后抽出公共函数。检查边界条件：空输入、并发写入。最后补上单元测试。",
  },
  {
    label: "neg-math",
    expected: false,
    reasoning: "对于该积分，先做变量替换 t = x^2，则 dt = 2x dx，化为标准形式后查表得到结果。",
  },
  {
    label: "pos-template-boilerplate",
    expected: true,
    reasoning: "好的，我来分析这个问题。首先，我们需要解决这个任务，接下来我们分析一下需求，然后进行处理。",
  },
  {
    label: "pos-refusal-template",
    expected: true,
    reasoning: "我不能直接给出建议，我不能完全提供答案，我不能告诉用户最终结果，因为我无法确定内容。",
  },
  {
    label: "neg-short-reasoning",
    expected: false,
    reasoning: "直接按需求实现即可。",
  },
  {
    label: "neg-empty",
    expected: false,
    reasoning: "",
  },
];

let tp = 0, tn = 0, fp = 0, fn = 0;
for (const s of samples) {
  const hit = detectCoTAnomaly(s.reasoning, DEFAULT_COT_RULES);
  const ok = hit === s.expected;
  if (ok) { if (s.expected) tp++; else tn++; } else { if (s.expected) fn++; else fp++; }
  console.log(`${ok ? "PASS" : "FAIL"}  ${s.label}  expected=${s.expected} got=${hit}`);
}
console.log(`\nTP=${tp} TN=${tn} FP=${fp} FN=${fn}`);
console.log(`precision=${(tp + fp) === 0 ? "n/a" : (tp / (tp + fp)).toFixed(2)}  recall=${(tp + fn) === 0 ? "n/a" : (tp / (tp + fn)).toFixed(2)}`);

// 模型可识别性启发式（假设口径，未实证）：只验证函数口径
console.log("\nisV4ProModel checks:");
console.log("deepseek-v4-pro ->", isV4ProModel("deepseek-v4-pro"));
console.log("deepseek-v4-pro-0324 ->", isV4ProModel("deepseek-v4-pro-0324"));
console.log("pi-ai/deepseek-v4-pro ->", isV4ProModel("pi-ai/deepseek-v4-pro"));
console.log("deepseek-chat ->", isV4ProModel("deepseek-chat"));

process.exit(fp + fn > 0 ? 1 : 0);
