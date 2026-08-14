import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

/**
 * 将模型输出中常见的 `$$\begin{aligned}…\end{aligned}$$` / 单行 `$$…$$` 规范为
 * micromark-extension-math 认识的 fence 形式（`$$` 独占一行）。否则 `\begin{aligned}`
 * 会被当作 fence meta 剥离，且闭合 `$$` 不被识别，导致整段被 KaTeX 解析失败并以红色
 * `.katex-error` 渲染。
 */
function normalizeMath(text: string): string {
  let out = text
    .replace(/\$\$\s*\\begin\{([^}]+)\}/g, "$$\n\\begin{$1}")
    .replace(/\\end\{([^}]+)\}\s*\$\$/g, "\\end{$1}\n$$");
  out = out.replace(/\$\$([^\n$]+)\$\$/g, "$$\n$1\n$$");
  return out;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
}
