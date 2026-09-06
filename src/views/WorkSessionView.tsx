import { useEffect, useRef, useState } from "react";
import { useAppState, appStore } from "../lib/dsh/store";
import { parseDispatchCommand } from "../lib/team";
import { displayTitle } from "../lib/dsh/sessionTitle";
import { ApprovalCard, EventRow, LiveAssistantRow, QuestionCard, shortId, useConversationItems, useLiveAssistant, useSessionInteractives } from "../components/Conversation";
import { ModelMenu } from "../components/ModelMenu";
import { WorkspaceMenu } from "../components/WorkspaceMenu";
import { AgentPresetChip } from "../components/AgentPresetChip";
import { PermissionMenu } from "../components/PermissionMenu";
import { CotWarningBanner } from "../components/CotWarningBanner";
import { HamburgerMenu, type ToolTab } from "../components/HamburgerMenu";
import type { SessionSubTab } from "../components/ToolDock";

/** 待发送图片附件（base64，未提交）。 */
interface PendingImage {
  mediaType: string;
  data: string;
  name?: string;
}

export function WorkSessionView({ onOpenSettings, onOpenToolDock, onOpenSessionDock, onGoTeam, mode }: { onOpenSettings?: () => void; onOpenToolDock: (tab: ToolTab | "team") => void; onOpenSessionDock?: (sub: SessionSubTab) => void; onGoTeam?: () => void; mode?: "work" | "code" }) {
  const { connected, sessions, selectedSessionId, history, stoppingSessions, sessionTitles, projections, sessionQueues, subagentCatalogs, pendingSkillInsert, dispatchBusy, modelGroups, defaultModel } = useAppState();
  const isWork = (mode ?? "work") === "work";
  const [slashOpen, setSlashOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const msgsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedSessionId && !history.has(selectedSessionId) && appStore.get().api) {
      void appStore.loadHistory(selectedSessionId).catch((e) => appStore.set({ error: `历史加载失败: ${String(e)}` }));
    }
  }, [selectedSessionId, history]);

  const items = useConversationItems();
  const liveAssistant = useLiveAssistant();
  // 贴底滚动：消息变化或流式内容增长时若用户已在底部则跟随到底部（不打断上翻查看历史）
  useEffect(() => {
    const el = msgsRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items.length, liveAssistant?.text.length, liveAssistant?.reasoning.length]);
  const interactives = useSessionInteractives();
  const reasoningText = [
    liveAssistant?.reasoning ?? "",
    ...items.filter((it) => it.kind === "assistant").map((it) => it.reasoning ?? ""),
  ].join("\n");
  const selected = sessions.find((s) => s.sessionId === selectedSessionId);
  const running = selected?.running ?? false;
  const stopping = selectedSessionId ? (stoppingSessions[selectedSessionId] ?? null) : null;

  // 会话功能坞「技能」子tab 点击技能 → 追加 /name 到输入框（消费后清空 pendingSkillInsert）
  useEffect(() => {
    if (pendingSkillInsert) {
      setDraft((d) => (d ? `${d}\n/${pendingSkillInsert} ` : `/${pendingSkillInsert} `));
      appStore.setSkillInsert(null);
    }
  }, [pendingSkillInsert]);

  // 会话头部入口工具栏的角标数据
  const goalView = selectedSessionId
    ? (projections.get(selectedSessionId)?.["goal"]?.value as { goal?: { phase: string } } | null | undefined)
    : undefined;
  const goalPhase = goalView?.goal?.phase ?? null;
  const queueCount = selectedSessionId ? (sessionQueues.get(selectedSessionId)?.length ?? 0) : 0;
  const runningSubagents = selectedSessionId
    ? (subagentCatalogs.get(selectedSessionId)?.entries.filter((e) => e.kind === "child" && e.activity === "running").length ?? 0)
    : 0;
  // PRD-003 团队入口双数：运行中绿 dot / 待审红数（与 team tab t-badge 同源同数，禁止合一；声音默认关）。
  const runningTotal = sessions.filter((s) => s.running).length;
  const pendingApprovals = interactives.filter((i) => i.kind === "approval").length;

  // 会话重命名（内联）：铅笔 → 输入框；Enter/失焦保存，Esc 取消
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (!selected) return;
    renameCommittedRef.current = false;
    setRenameDraft(displayTitle(selected, sessionTitles) ?? shortId(selected.sessionId));
    setRenaming(true);
  };
  const cancelRename = () => {
    renameCommittedRef.current = true;
    setRenaming(false);
  };
  const commitRename = () => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const t = renameDraft.trim();
    setRenaming(false);
    if (t && selected) void appStore.renameSession(selected.sessionId, t);
  };


  // 图片附件读取（base64）+ 数量/大小预检（imageLimits 投影；缺失则交给宿主校验）
  const imageLimits = (selectedSessionId ? projections.get(selectedSessionId)?.["imageLimits"]?.value : undefined) as
    | { maxImagesPerMessage: number; maxImageBytes: number; maxMessageImageBytes: number; mediaTypes: string[] }
    | undefined;
  const pickImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const next: PendingImage[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      if (imageLimits && !imageLimits.mediaTypes.includes(f.type)) {
        appStore.set({ error: `不支持的图片类型: ${f.type}（允许: ${imageLimits.mediaTypes.join(", ")}）` });
        continue;
      }
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (imageLimits && bytes.length > imageLimits.maxImageBytes) {
        appStore.set({ error: `图片 ${f.name} 超过单图上限（${Math.round(imageLimits.maxImageBytes / 1024)}KB）` });
        continue;
      }
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      next.push({ mediaType: f.type, data: btoa(bin), name: f.name });
    }
    const merged = [...images, ...next];
    if (imageLimits && merged.length > imageLimits.maxImagesPerMessage) {
      appStore.set({ error: `每条消息最多 ${imageLimits.maxImagesPerMessage} 张图片` });
      return;
    }
    setImages(merged);
  };

  const send = () => {
    const text = draft.trim();
    if ((!text && images.length === 0) || !selectedSessionId) return;
    // PRD-dispatch S0：Work 会话 composer 发前 ^/分派 拦截；无前缀=闲聊直答；空参数=用法提示；非 Work=提示去 Work。
    const cmd = parseDispatchCommand(text);
    if (cmd) {
      if ("empty" in cmd) {
        appStore.set({ notice: "用法：/分派 <需求>（如：/分派 把登录页拆成3卡分给前端/后端/测试）" });
        return;
      }
      if (!isWork) {
        appStore.set({ notice: "请到 Work 模式使用（当前为 Code 模式，不跨模式执行）" });
        return;
      }
      if (!connected) {
        appStore.set({ error: "dsh 未连接，无法拆解（请先连接后再 /分派）" });
        return;
      }
      if (!modelGroups) {
        appStore.set({ error: "模型目录不可用，无法拆解（请先在设置页加载模型目录）" });
        return;
      }
      if (!defaultModel?.value?.provider || !defaultModel?.value?.model) {
        const dispMode = appStore.get().dispatchModel?.setting?.mode ?? "follow-default";
        const dispVal = appStore.get().dispatchModel?.setting;
        const specifiedOk = dispMode === "specified" && dispVal?.provider && dispVal?.model;
        if (!specifiedOk) {
          appStore.set({ error: "默认模型未配置，无法拆解（请先在设置页配置默认模型）" });
          return;
        }
      }
      const requirement = cmd.requirement;
      setDraft("");
      setImages([]);
      setSlashOpen(true);
      void appStore.startDispatch(requirement, selectedSessionId);
      return;
    }
    if (!connected) return;
    if (imageLimits && images.length > 0) {
      const total = images.reduce((n, img) => n + Math.floor((img.data.length * 3) / 4), 0);
      if (total > imageLimits.maxMessageImageBytes) {
        appStore.set({ error: `图片总量超过单条消息上限（${Math.round(imageLimits.maxMessageImageBytes / 1024)}KB）` });
        return;
      }
    }
    void appStore.sendPrompt(selectedSessionId, text, images);
    setDraft("");
    setImages([]);
  };

  return (
    <section className="view active" id="view-session">
      <div className="col col-conv">
        <div className="view-cap">会话</div>
        <div className="conv-head">
          <div className="conv-title-wrap">
            {renaming && selected ? (
              <input
                className="conv-rename-input"
                value={renameDraft}
                autoFocus
                onChange={(e) => setRenameDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                  if (e.key === "Escape") cancelRename();
                }}
                onBlur={commitRename}
              />
            ) : (
              <>
                <span className="conv-title">{selected ? (displayTitle(selected, sessionTitles) ?? shortId(selected.sessionId)) : "未选择会话（从左侧任务列表选择）"}</span>
                {selected && (
                  <button className="conv-rename-btn" title="重命名会话" disabled={!connected} onClick={startRename}>✎</button>
                )}
              </>
            )}
          </div>
          <span className={`badge ${running ? "orange" : "gray"}`}>{running ? "运行中" : "已停止"}</span>
          {stopping && <span className="badge orange">正在停止…</span>}
          <div className="ent-bar">
            <button
              className={`ent-btn${goalPhase ? "" : " guide"}`}
              title={goalPhase ? "目标" : "无目标 → 点击进入「设定目标」引导"}
              onClick={() => onOpenSessionDock?.("goal")}
            >
              <span className="ent-ico">◎</span>
              <span>{goalPhase ? "目标" : "＋ 设定目标"}</span>
              {goalPhase === "active" && <span className="ent-dot green" />}
              {goalPhase === "paused" && <span className="ent-dot orange" />}
              {goalPhase === "complete" && <span className="ent-dot gray" />}
            </button>
            <button
              className="ent-btn"
              title="队列"
              onClick={() => onOpenSessionDock?.("queue")}
            >
              <span className="ent-ico">☰</span>
              <span>队列</span>
              {queueCount > 0 && <span className="ent-badge red">{queueCount}</span>}
            </button>
            <button
              className="ent-btn"
              title="子代理"
              onClick={() => onOpenSessionDock?.("subagents")}
            >
              <span className="ent-ico">◔</span>
              <span>子代理</span>
              {runningSubagents > 0 && <span className="ent-badge green">{runningSubagents}</span>}
            </button>
            <button
              className="ent-btn"
              title="技能"
              onClick={() => onOpenSessionDock?.("skills")}
            >
              <span className="ent-ico">✦</span>
              <span>技能</span>
            </button>
            <button
              className="ent-btn"
              title={onGoTeam ? "回到团队黑板（Work）" : "团队黑板（只读聚合）"}
              onClick={() => (onGoTeam ? onGoTeam() : onOpenToolDock("team"))}
            >
              <span className="ent-ico">▦</span>
              <span>团队</span>
              {runningTotal > 0 && <span className="ent-dot green" title={`运行中 ${runningTotal}`} />}
              {pendingApprovals > 0 && <span className="ent-badge red">{pendingApprovals}</span>}
            </button>
          </div>
          <HamburgerMenu onOpenTool={onOpenToolDock} />
        </div>
        <div className="msgs" ref={msgsRef}>
          {selectedSessionId && <CotWarningBanner sessionId={selectedSessionId} reasoning={reasoningText} />}
          {interactives.map((i) => (i.kind === "approval" ? <ApprovalCard key={i.rpcId} item={i} /> : <QuestionCard key={i.rpcId} item={i} />))}
          {items.length === 0 && <div className="empty-state">还没有消息</div>}
          {items.map((it) => <EventRow key={it.seq} item={it} sessionId={selectedSessionId ?? undefined} />)}
          <LiveAssistantRow />
          {dispatchBusy && <div className="thinking-indicator">● 正在拆解…（隔离会话 prompt，串行一拆解一调用，60s 超时转回退）</div>}
          {stopping ? <div className="thinking-indicator">■ 正在停止生成…（2 秒内切换为已停止）</div> : running && !liveAssistant && !dispatchBusy ? <div className="thinking-indicator">● 模型正在思考中…</div> : null}
        </div>
        <div className="composer-wrap">
          <div className="composer" style={{ position: "relative" }}>
            {images.length > 0 && (
              <div className="attach-chips">
                {images.map((img, i) => (
                  <span className="attach-chip" key={i} title={img.name ?? img.mediaType}>
                    <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name ?? ""} />
                    <button className="attach-x" title="移除" onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button>
                  </span>
                ))}
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                void pickImages(e.target.files);
                e.target.value = "";
              }}
            />
            <textarea
              className="composer-input"
              value={draft}
              onChange={(e) => {
                setDraft(e.currentTarget.value);
                if (e.currentTarget.value.startsWith("/")) setSlashOpen(true);
              }}
              placeholder={isWork ? "输入消息…（/分派 <需求> 拆解分派）" : "输入消息…"}
              onKeyDown={(e) => {
                if (e.key === "Escape" && slashOpen && draft.startsWith("/")) {
                  e.preventDefault();
                  setSlashOpen(false);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {isWork && slashOpen && draft.startsWith("/") && (
              <div className="perm-pop" role="listbox" aria-label="斜杠补全">
                <div
                  className="preset-row"
                  title="Work 会话唯一入口：/分派 <需求>（无前缀=闲聊直答；空参数=用法提示）"
                  onClick={() => {
                    setDraft((d) => (d.startsWith("/分派") ? d : "/分派 "));
                    setSlashOpen(false);
                  }}
                >
                  <span className="preset-meta">
                    <span className="preset-nm">/分派 {"<需求>"}</span>
                    <span className="preset-ds">拆解为任务卡并按 role/skill 确定性匹配分派（Esc 关闭）</span>
                  </span>
                </div>
              </div>
            )}
            <div className="toolbar">
              <div className="tools">
                <button
                  className="plus-btn"
                  title={imageLimits ? `附加图片（每条最多 ${imageLimits.maxImagesPerMessage} 张）` : "附加图片"}
                  onClick={() => fileRef.current?.click()}
                >
                  +
                </button>
              </div>
              <div className="tools">
                <ModelMenu onOpenSettings={onOpenSettings} />
                <button
                  className={`send-btn${running ? " stop" : ""}`}
                  title={stopping ? "正在停止…" : running ? "停止当前任务" : "发送消息"}
                  disabled={!connected || !!stopping}
                  onClick={() => (running && selectedSessionId ? void appStore.stopSession(selectedSessionId) : send())}
                >
                  {running ? "■" : "↑"}
                </button>
              </div>
            </div>
          </div>
          <div className="env-bar">
            {selectedSessionId ? <PermissionMenu sessionId={selectedSessionId} /> : null}
            <button className="env-btn" title="执行环境（开发中）">本地 <span className="caret">▾</span></button>
            <WorkspaceMenu />
            {selectedSessionId ? <AgentPresetChip sessionId={selectedSessionId} /> : null}
          </div>
        </div>
      </div>
    </section>
  );
}








