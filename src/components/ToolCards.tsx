/**
 * Official tool-call / tool-result card rendering.
 *
 * Implements devContext item 8 against the pinned dsh 0.1.0-rc.6 presentation
 * contract (@deepseek-ai/dsh-tools/presentation): DiffCallView/DiffResultView,
 * TerminalCallView/TerminalResultView, ReadResultView, SearchResultView,
 * WebResultView, GenericCallView/GenericResultView. When the host-computed
 * ToolEventView is absent, falls back to a compact generic JSON card.
 */
import type { ToolEventView } from "@deepseek-ai/dsh-host-apiproxy/api";
import type {
  DiffCallView,
  DiffResultView,
  FileDiff,
  GenericCallView,
  GenericResultView,
  ReadResultView,
  SearchMatchesResultView,
  SearchPathsResultView,
  TerminalCallView,
  TerminalResultView,
  WebFetchResultView,
  WebSearchResultView,
} from "@deepseek-ai/dsh-tools/presentation";

type ToolView = ToolEventView["view"];

function contentBlockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .join("\n");
  }
  return "";
}

function DiffLines({ diff }: { diff: FileDiff }) {
  const oldLines = diff.oldText ? diff.oldText.split("\n") : [];
  const newLines = diff.newText.split("\n");
  return (
    <div className="tool-diff">
      <div className="tool-diff-path">{diff.path}</div>
      {oldLines.map((line, i) => (
        <div className="diff-line del" key={`o${i}`}>
          <span className="ln">{i + 1}</span>
          <span className="code">{line}</span>
        </div>
      ))}
      {newLines.map((line, i) => (
        <div className="diff-line add" key={`n${i}`}>
          <span className="ln">{i + 1}</span>
          <span className="code">{line}</span>
        </div>
      ))}
    </div>
  );
}

function DiffCard({ view }: { view: DiffCallView | DiffResultView }) {
  return (
    <div className="toolcard">
      <div className="toolcard-head">
        <span className="toolcard-title">{view.title ?? "文件修改"}</span>
        <span className="badge">{view.diffs.length} 个文件</span>
      </div>
      <div className="toolcard-body">
        {view.diffs.map((d, i) => (
          <DiffLines key={`${d.path}#${i}`} diff={d} />
        ))}
      </div>
    </div>
  );
}

function TerminalCard({ view }: { view: TerminalCallView | TerminalResultView }) {
  const call = view as TerminalCallView;
  const result = view as TerminalResultView;
  const cwd = call.cwd ?? (view as { cwd?: string }).cwd;
  return (
    <div className="toolcard">
      <div className="toolcard-head">
        <span className="toolcard-title mono">$ {result.title ?? call.title}</span>
        {typeof result.exitCode === "number" && (
          <span className={`badge ${result.exitCode === 0 ? "green" : "orange"}`}>exit {result.exitCode}</span>
        )}
        {result.signal && <span className="badge orange">signal {result.signal}</span>}
      </div>
      {call.description && <div className="toolcard-desc">{call.description}</div>}
      {cwd && <div className="toolcard-cwd mono">{cwd}</div>}
      {result.output != null && (
        <pre className="toolcard-output mono">{result.output}</pre>
      )}
    </div>
  );
}

function ReadCard({ view }: { view: ReadResultView }) {
  return (
    <div className="toolcard">
      <div className="toolcard-head">
        <span className="toolcard-title mono">{view.title ?? view.path}</span>
        <span className="badge">
          显示 {view.lines.length} / {view.totalLines} 行
          {view.lang ? ` · ${view.lang}` : ""}
        </span>
      </div>
      <div className="toolcard-body read-body mono">
        {view.lines.length === 0 ? (
          <div className="empty-state">（空窗口，offset={view.offset}）</div>
        ) : (
          view.lines.map((l) => (
            <div className="read-line" key={l.number}>
              <span className="ln">{l.number}</span>
              <span className="code">{l.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SearchMatchesView({ view }: { view: SearchMatchesResultView }) {
  return (
    <div className="toolcard">
      <div className="toolcard-head">
        <span className="toolcard-title">{view.title ?? "搜索"}</span>
        <span className="badge">
          {view.total} 处{view.truncated ? "（已截断）" : ""}
        </span>
      </div>
      <div className="toolcard-body">
        {view.files.map((f) => (
          <div className="search-file" key={f.path}>
            <div className="tool-diff-path mono">{f.path}</div>
            {f.matches.map((m, i) => (
              <div className="search-match mono" key={i}>
                <span className="ln">{m.lineNumber}</span>
                <span className="code">{m.line}</span>
              </div>
            ))}
          </div>
        ))}
        {view.files.length === 0 && <div className="empty-state">（无匹配）</div>}
      </div>
    </div>
  );
}

function SearchPathsView({ view }: { view: SearchPathsResultView }) {
  return (
    <div className="toolcard">
      <div className="toolcard-head">
        <span className="toolcard-title">{view.title ?? "搜索"}</span>
        <span className="badge">
          {view.total} 项{view.truncated ? "（已截断）" : ""}
        </span>
      </div>
      <div className="toolcard-body mono">
        {view.paths.map((p, i) => (
          <div key={i} className="search-path">{p}</div>
        ))}
        {view.paths.length === 0 && <div className="empty-state">（无结果）</div>}
      </div>
    </div>
  );
}

function WebSearchView({ view }: { view: WebSearchResultView }) {
  return (
    <div className="toolcard">
      <div className="toolcard-head">
        <span className="toolcard-title">{view.title ?? "网络搜索"}</span>
        <span className="badge">{view.sources.length} 个来源{view.truncated ? "（已截断）" : ""}</span>
      </div>
      {view.answer && <div className="toolcard-desc">{view.answer}</div>}
      <div className="toolcard-body">
        {view.sources.map((s, i) => (
          <div className="web-source" key={i}>
            <div className="web-source-title">{s.title ?? s.url}</div>
            {s.url && <div className="web-source-url mono">{s.url}</div>}
            {s.snippet && <div className="web-source-snippet">{s.snippet}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function WebFetchView({ view }: { view: WebFetchResultView }) {
  return (
    <div className="toolcard">
      <div className="toolcard-head">
        <span className="toolcard-title">{view.title ?? "网页抓取"}</span>
        <span className={`badge ${view.statusCode >= 200 && view.statusCode < 400 ? "green" : "orange"}`}>
          HTTP {view.statusCode}
        </span>
      </div>
      <div className="toolcard-body">
        <div className="toolcard-cwd mono">{view.url}</div>
        {view.truncated && <div className="toolcard-desc">（内容已截断）</div>}
      </div>
    </div>
  );
}

function GenericCard({ view }: { view: GenericCallView | GenericResultView }) {
  const call = view as GenericCallView;
  const result = view as GenericResultView;
  const title = result.title ?? call.title ?? "工具";
  const raw = "rawInput" in call ? call.rawInput : undefined;
  const content = result.content ?? call.content;
  const locations = "locations" in call ? call.locations : undefined;
  return (
    <div className="toolcard">
      <div className="toolcard-head">
        <span className="toolcard-title">{title}</span>
        {call.kind && <span className="badge">{call.kind}</span>}
      </div>
      {raw !== undefined && (
        <pre className="toolcard-output mono">{typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)}</pre>
      )}
      {content && content.length > 0 && <div className="toolcard-body">{contentBlockText(content)}</div>}
      {locations && locations.length > 0 && (
        <div className="toolcard-cwd mono">
          {locations.map((l) => (l.line != null ? `${l.path}:${l.line}` : l.path)).join("\n")}
        </div>
      )}
    </div>
  );
}

function FallbackCard({ evType, data, seq }: { evType: string; data: unknown; seq: number }) {
  return (
    <div className="toolcall mono" title={`${evType} @${seq}`}>
      {evType} @{seq}: {JSON.stringify(data).slice(0, 500)}
    </div>
  );
}

export function ToolEventCard({ view, evType, data, seq }: { view: unknown; evType: string; data: unknown; seq: number }) {
  if (!view) return <FallbackCard evType={evType} data={data} seq={seq} />;
  const tv = view as ToolEventView;
  if (!tv || tv.for !== "call" && tv.for !== "result" || !tv.view) {
    return <FallbackCard evType={evType} data={data} seq={seq} />;
  }
  const v = tv.view as ToolView;
  switch (v.card) {
    case "diff":
      return <DiffCard view={v as DiffCallView | DiffResultView} />;
    case "terminal":
      return <TerminalCard view={v as TerminalCallView | TerminalResultView} />;
    case "read":
      return <ReadCard view={v as ReadResultView} />;
    case "search":
      return (v as SearchMatchesResultView | SearchPathsResultView).shape === "paths"
        ? <SearchPathsView view={v as SearchPathsResultView} />
        : <SearchMatchesView view={v as SearchMatchesResultView} />;
    case "web":
      return (v as WebSearchResultView | WebFetchResultView).kind === "fetch"
        ? <WebFetchView view={v as WebFetchResultView} />
        : <WebSearchView view={v as WebSearchResultView} />;
    case "generic":
    default:
      return <GenericCard view={v as GenericCallView | GenericResultView} />;
  }
}
