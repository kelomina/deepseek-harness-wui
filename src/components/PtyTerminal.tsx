import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "xterm/css/xterm.css";
import { MAX_PTY_SESSIONS, onPtyExit, onPtyOutput, pty } from "../lib/pty";

/**
 * 真 pty → xterm 绑定（任务#7，CONTRACT 2026-09-07T06:00Z）。
 * - xterm 实例 ↔ pty id 一对一绑定；输入→pty_write；`pty-output/pty-exit` 单监听按 id 分流。
 * - resize→pty_resize（含 fit 联动）；切 tab 仅隐藏不卸载（不杀 pty）；关 tab/关窗口→pty_kill。
 * - 失败态：超限/启动失败显式错误 + 重试，不静默。样式沿用现有 token（btn/badge/empty-state/hint/toolcall-err/term-tabs）。
 */

interface PtyTab {
  key: number;
  ptyId: string | null;
  cwd: string;
  starting: boolean;
  error: string | null;
  dead: boolean;
  exitCode: number | null;
}

interface TermHandles {
  term: Terminal;
  fit: FitAddon;
}

function isFitReady(h: TermHandles): boolean {
  // 根因：隐藏 tab/未 layout/dispose 后 _renderService 未就绪，
  // proposeDimensions 内读 `_renderService.dimensions` 即抛
  // `Cannot read properties of undefined (reading 'dimensions')`。
  const el = h.term.element;
  if (!el || !el.isConnected) return false;
  const parent = el.parentElement;
  if (!parent || parent.clientWidth <= 0 || parent.clientHeight <= 0) return false;
  const core = (h.term as unknown as { _core?: { _renderService?: unknown } })._core;
  if (!core?._renderService) return false;
  return true;
}

function friendlyPtyError(e: unknown): string {
  const s = String(e);
  // 后端原文直透（含“并发已达上限(4)”/“cwd 不存在”/“shell 启动失败”等），仅去 Tauri 前缀噪音。
  return s.replace(/^InvokeError:\s*/i, "").replace(/^Error:\s*/i, "");
}

function PtyPane({
  tabKey,
  visible,
  register,
  unregister,
  onUserInput,
}: {
  tabKey: number;
  visible: boolean;
  register: (key: number, h: TermHandles) => void;
  unregister: (key: number) => void;
  onUserInput: (key: number, data: string) => void;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const cbRef = useRef({ register, unregister, onUserInput });
  cbRef.current = { register, unregister, onUserInput };

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily: 'ui-monospace,Consolas,"Courier New",monospace',
      theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const unicode = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(unicode);
    try {
      term.unicode.activeVersion = "11";
    } catch {
      /* 中文宽字符增强 best-effort，失败仍可用 */
    }
    term.open(el);
    // 首帧 fit 守卫：隐藏 tab/零尺寸不调，待父级切 tab 可见时补 fit（dirty 语义）
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    }
    const disp = term.onData((data) => cbRef.current.onUserInput(tabKey, data));
    cbRef.current.register(tabKey, { term, fit });
    return () => {
      disp.dispose();
      cbRef.current.unregister(tabKey);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey]);

  return (
    <div
      ref={elRef}
      className="pty-screen mono"
      style={{ display: visible ? "block" : "none", width: "100%", height: "100%", minHeight: 0 }}
    />
  );
}

export function PtyTabs({
  defaultCwd,
  canOpenPath,
  showCwdInput = true,
}: {
  /** 新会话 cwd（终端=工作区根；Git=仓库目录）。已建会话保持原 cwd。 */
  defaultCwd: string | null;
  /** Git 双查门禁：false=显式禁绑（binding+spawn 双查）；undefined/null=不设门（终端 tab）。 */
  canOpenPath?: boolean | null;
  showCwdInput?: boolean;
}) {
  const [tabs, setTabs] = useState<PtyTab[]>([]);
  const [activeKey, setActiveKey] = useState<number | null>(null);
  const [cwdDraft, setCwdDraft] = useState(defaultCwd ?? "");
  const [globalError, setGlobalError] = useState<string | null>(null);
  const keySeq = useRef(0);
  const terms = useRef(new Map<number, TermHandles>());
  const ptyIdByKey = useRef(new Map<number, string>());
  const keyByPtyId = useRef(new Map<string, number>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const cwdRef = useRef(cwdDraft);
  cwdRef.current = cwdDraft;
  const gateRef = useRef(canOpenPath);
  gateRef.current = canOpenPath;
  const fitTimers = useRef(new Map<number, number>());
  const pendingFit = useRef(new Set<number>());

  useEffect(() => {
    setCwdDraft(defaultCwd ?? "");
  }, [defaultCwd]);

  const gated = canOpenPath === false;
  const activeTab = tabs.find((t) => t.key === activeKey) ?? null;

  const fitAndResize = useCallback((key: number) => {
    const h = terms.current.get(key);
    const ptyId = ptyIdByKey.current.get(key);
    if (!h || !ptyId) return;
    const tab = tabsRef.current.find((t) => t.key === key);
    if (!tab || tab.dead || tab.starting || tab.error) return;
    // 守卫：不可见/零尺寸/_renderService 未就绪不调 fit，记 dirty 待切 tab 可见补 fit（不断连）
    if (!isFitReady(h)) {
      pendingFit.current.add(key);
      return;
    }
    pendingFit.current.delete(key);
    let dims: { cols: number; rows: number } | undefined;
    try {
      h.fit.fit();
      dims = h.fit.proposeDimensions() ?? undefined;
    } catch {
      return;
    }
    if (!dims || !dims.cols || !dims.rows) return;
    const cols = Math.max(1, Math.min(500, dims.cols));
    const rows = Math.max(1, Math.min(500, dims.rows));
    void pty.resize(ptyId, cols, rows).catch(() => {
      /* resize 失败不刷屏，终端仍可用 */
    });
  }, []);

  const scheduleFit = useCallback(
    (key: number) => {
      const prev = fitTimers.current.get(key);
      if (prev) window.clearTimeout(prev);
      fitTimers.current.set(
        key,
        window.setTimeout(() => fitAndResize(key), 120),
      );
    },
    [fitAndResize],
  );

  const spawnFor = useCallback(
    async (key: number, cwd: string) => {
      // 双查第二查：spawn 时刻复核门禁（binding 时刻已在渲染层置灰）。
      if (gateRef.current === false) {
        setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, starting: false, error: "canOpenPath=false，边界复查未通过（显式禁绑，转人工处理）" } : t)));
        return;
      }
      setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, starting: true, error: null, dead: false, exitCode: null } : t)));
      setGlobalError(null);
      try {
        const id = await pty.spawn(cwd.trim() || null, 80, 24);
        ptyIdByKey.current.set(key, id);
        keyByPtyId.current.set(id, key);
        setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, ptyId: id, starting: false, error: null } : t)));
        // spawn 后按实际渲染尺寸校准一次
        window.setTimeout(() => fitAndResize(key), 60);
      } catch (e) {
        const msg = friendlyPtyError(e);
        setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, starting: false, error: msg } : t)));
        if (/上限\(4\)/.test(msg)) setGlobalError(msg);
      }
    },
    [fitAndResize],
  );

  const createTab = useCallback(() => {
    if (gateRef.current === false) {
      setGlobalError("canOpenPath=false，边界复查未通过（显式禁绑，转人工处理）");
      return;
    }
    if (tabsRef.current.length >= MAX_PTY_SESSIONS) {
      setGlobalError(`pty 并发已达上限(${MAX_PTY_SESSIONS})，请先关闭空闲会话`);
      return;
    }
    keySeq.current += 1;
    const key = keySeq.current;
    const cwd = cwdRef.current ?? "";
    setTabs((ts) => [...ts, { key, ptyId: null, cwd, starting: true, error: null, dead: false, exitCode: null }]);
    setActiveKey(key);
    void spawnFor(key, cwd);
  }, [spawnFor]);

  const retryTab = useCallback(
    (key: number) => {
      const tab = tabsRef.current.find((t) => t.key === key);
      if (!tab) return;
      // 退出/失败重试 = 旧 id 已摘表，直接重 spawn（旧 term 保留续写分隔线）
      const h = terms.current.get(key);
      h?.term.writeln("\r\n--- 重新连接 ---");
      void spawnFor(key, tab.cwd);
    },
    [spawnFor],
  );

  const closeTab = useCallback((key: number) => {
    const id = ptyIdByKey.current.get(key);
    if (id) {
      keyByPtyId.current.delete(id);
      ptyIdByKey.current.delete(key);
      void pty.kill(id).catch(() => {
        /* 关闭 best-effort：会话已退/不存在不刷屏 */
      });
    }
    terms.current.get(key)?.term.dispose();
    terms.current.delete(key);
    pendingFit.current.delete(key);
    setTabs((ts) => {
      const next = ts.filter((t) => t.key !== key);
      setActiveKey((cur) => {
        if (cur !== key) return cur;
        return next.length ? next[next.length - 1].key : null;
      });
      return next;
    });
  }, []);

  // 首个 tab 自动建（cwd 就绪后；门禁 false 时不自动建，只显式提示）
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current) return;
    if (gateRef.current === false) return;
    autoTried.current = true;
    createTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 单监听 pty-output/pty-exit，按 id 分流写屏（勿拼 pty-output-{id}）
  useEffect(() => {
    let outOff: (() => void) | undefined;
    let exitOff: (() => void) | undefined;
    void onPtyOutput((e) => {
      const key = keyByPtyId.current.get(e.id);
      if (key === undefined) return;
      terms.current.get(key)?.term.write(e.data);
    }).then((off) => {
      outOff = off;
    });
    void onPtyExit((e) => {
      const key = keyByPtyId.current.get(e.id);
      if (key === undefined) return;
      keyByPtyId.current.delete(e.id);
      ptyIdByKey.current.delete(key);
      const h = terms.current.get(key);
      try {
        h?.term.writeln(`\r\n[pty ${e.id} 已退出${e.exit_code != null ? `，exit ${e.exit_code}` : ""}]`);
      } catch {
        /* ignore */
      }
      setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, dead: true, exitCode: e.exit_code } : t)));
    }).then((off) => {
      exitOff = off;
    });
    return () => {
      outOff?.();
      exitOff?.();
    };
  }, []);

  // 关窗口→pty_kill（best-effort；后端进程退出亦会回收）
  useEffect(() => {
    const onUnload = () => {
      for (const id of ptyIdByKey.current.values()) {
        try {
          void pty.kill(id);
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  // 卸载（切 Dock tab）时不杀 pty？——本组件卸载即“关窗口/关面板”语义，按契约杀残留。
  useEffect(() => {
    return () => {
      for (const t of fitTimers.current.values()) window.clearTimeout(t);
      for (const id of ptyIdByKey.current.values()) {
        void pty.kill(id).catch(() => undefined);
      }
      ptyIdByKey.current.clear();
      keyByPtyId.current.clear();
    };
  }, []);

  // 切 tab 后重 fit（隐藏→显示尺寸变化联动 resize；后台 tab 不断连，仅补尺寸）
  useEffect(() => {
    if (activeKey == null) return;
    // rAF 待 display:none→flex layout 就绪后再 fit，60ms 定时兜底脏页
    const raf = window.requestAnimationFrame(() => fitAndResize(activeKey));
    const t = window.setTimeout(() => fitAndResize(activeKey), 60);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [activeKey, fitAndResize]);

  // 容器尺寸变化 → fit 联动 resize
  useEffect(() => {
    const onResize = () => {
      if (activeKey != null) scheduleFit(activeKey);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [activeKey, scheduleFit]);

  const register = useCallback(
    (key: number, h: TermHandles) => {
      terms.current.set(key, h);
      if (key === activeKey) scheduleFit(key);
      else {
        // 后台 tab 隐藏不断连：不可见时 fitAndResize 内记 dirty，切回时补 fit，不抛错
        window.setTimeout(() => fitAndResize(key), 80);
      }
    },
    [activeKey, fitAndResize, scheduleFit],
  );
  const unregister = useCallback((key: number) => {
    terms.current.delete(key);
    pendingFit.current.delete(key);
    const timer = fitTimers.current.get(key);
    if (timer) {
      window.clearTimeout(timer);
      fitTimers.current.delete(key);
    }
  }, []);

  const onUserInput = useCallback((key: number, data: string) => {
    const id = ptyIdByKey.current.get(key);
    if (!id) return;
    void pty.write(id, data).catch((e) => {
      const msg = friendlyPtyError(e);
      terms.current.get(key)?.term.writeln(`\r\n[写入失败] ${msg}`);
    });
  }, []);

  const atLimit = tabs.length >= MAX_PTY_SESSIONS;

  return (
    <div className="pty-wrap">
      {showCwdInput && (
        <div className="tp-input-row">
          <span className="tp-prompt mono">cwd</span>
          <input
            className="input tp-cwd"
            placeholder="新终端工作目录（空=主目录）"
            value={cwdDraft}
            onChange={(e) => setCwdDraft(e.currentTarget.value)}
          />
          <button className="btn sm primary" disabled={atLimit || gated} onClick={createTab} title={gated ? "canOpenPath=false，显式禁绑" : `新建终端（上限${MAX_PTY_SESSIONS}）`}>
            ＋ 新建
          </button>
        </div>
      )}
      {gated && <div className="hint">canOpenPath=false，边界复查未通过（显式禁绑，转人工处理）。快捷栏仍可用。</div>}
      {globalError && (
        <div className="toolcall toolcall-err">
          <span>{globalError}</span>
          <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setGlobalError(null)}>
            关闭
          </button>
        </div>
      )}
      <div className="term-tabs" style={{ marginTop: 4 }}>
        {tabs.map((t, i) => (
          <span
            key={t.key}
            className={`t-tab${t.key === activeKey ? " on" : ""}`}
            onClick={() => setActiveKey(t.key)}
            title={t.ptyId ?? t.cwd ?? ""}
          >
            {t.dead ? "◼" : "●"} #{i + 1} {t.ptyId ?? "启动中…"}
            <button
              className="pty-x"
              title="关闭该终端（pty_kill）"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.key);
              }}
            >
              ×
            </button>
          </span>
        ))}
        {tabs.length === 0 && <span className="t-tab">（无终端）</span>}
        {!showCwdInput && (
          <button className="btn sm" style={{ marginLeft: "auto" }} disabled={atLimit || gated} onClick={createTab} title={gated ? "canOpenPath=false，显式禁绑" : `新建终端（上限${MAX_PTY_SESSIONS}）`}>
            ＋ 新建
          </button>
        )}
      </div>
      {atLimit && <div className="hint">已达上限({MAX_PTY_SESSIONS})：关闭空闲会话后可新建。</div>}
      <div className="pty-body">
        {tabs.length === 0 && <div className="empty-state">尚未启动终端（点“新建” spawn 常驻 shell）</div>}
        {tabs.map((t) => (
          <div key={t.key} style={{ display: t.key === activeKey ? "flex" : "none", flexDirection: "column", height: "100%", minHeight: 0 }}>
            {(t.starting || t.error || t.dead) && (
              <div className={`toolcall${t.error ? " toolcall-err" : ""}`} style={{ margin: "6px 0" }}>
                {t.starting && <span>正在启动 {t.cwd.trim() || "（主目录）"} …</span>}
                {t.error && (
                  <span>
                    启动失败：{t.error}
                    <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => retryTab(t.key)}>
                      重试
                    </button>
                  </span>
                )}
                {t.dead && !t.error && (
                  <span>
                    会话已退出{t.exitCode != null ? `（exit ${t.exitCode}）` : ""}
                    <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => retryTab(t.key)}>
                      重新连接
                    </button>
                  </span>
                )}
              </div>
            )}
            <PtyPane tabKey={t.key} visible={t.key === activeKey} register={register} unregister={unregister} onUserInput={onUserInput} />
          </div>
        ))}
        {/* 活跃 tab 为空时保持容器高度，避免 xterm fit 取 0 尺寸 */}
        {activeTab == null && tabs.length > 0 && <div className="empty-state">请选择一个终端页签</div>}
      </div>
    </div>
  );
}
