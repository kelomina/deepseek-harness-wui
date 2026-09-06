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
  /** 挂载代际：StrictMode 双挂载/重建时迟到回调对代际即弃，防 gen1 timer 打到 gen2 首帧 */
  gen: number;
}

let guardV4Logged = false;
let ptyGenSeq = 0;
/** 孤儿 timer 精确签名：只认 xterm 内部 Viewport/open 路径的 dimensions 崩，禁宽吞。 */
function isOrphanViewportDimError(e: unknown): boolean {
  const msg = String((e as Error | undefined)?.message ?? e ?? "");
  if (!msg.includes("dimensions")) return false;
  const stack = (e as Error | undefined)?.stack ?? "";
  if (!/xterm/i.test(stack)) return false;
  return /get dimensions|Viewport|_innerRefresh|_refresh|syncScrollArea|RenderService|Terminal\.open/i.test(stack);
}

type FitSkipReason = "not-open" | "hidden" | "disposed" | "stale-generation" | "not-ready" | "exception";

function fitSkipReason(h: TermHandles, expectGen?: number): FitSkipReason | null {
  if (expectGen !== undefined && h.gen !== expectGen) return "stale-generation";
  // 真凶：xterm.js:1776 `return this._renderer.value.dimensions;` ——崩的是
  // RenderService._renderer.value（首帧 setRenderer 前/dispose 后为 undefined），
  // 不是 _renderService 本身。旧守卫只判 core._renderService 存在故被绕过，
  // FitAddon.proposeDimensions 内读 `_renderService.dimensions` 即抛。
  // 本函数内对 rs.dimensions 的读取即“金丝雀”：必在 try 内，抛即 not-ready。
  try {
    const el = h.term.element;
    if (!el) return "not-open";
    if (!el.isConnected) return "disposed";
    const parent = el.parentElement;
    if (!parent || parent.clientWidth <= 0 || parent.clientHeight <= 0) return "hidden";
    const core = (h.term as unknown as { _core?: { _renderService?: { hasRenderer?: () => boolean; _renderer?: { value?: unknown }; dimensions?: unknown }; isDisposed?: boolean } })._core;
    if (!core || core.isDisposed) return "disposed";
    const rs = core._renderService;
    if (!rs) return "not-open";
    if (typeof rs.hasRenderer === "function" && !rs.hasRenderer()) return "not-ready";
    if (!rs._renderer?.value) return "not-ready";
    if (!rs.dimensions) return "not-ready";
    return null;
  } catch {
    return "exception";
  }
}

function logFitSkipped(reason: FitSkipReason): void {
  console.debug(`[pty] fit skipped: ${reason}`);
}

/** 唯一 .dimensions 读取入口：守卫 + fit/propose 二连 + try/catch 兜底记 dirty（调用方负责 pendingFit）。 */
function guardedFit(h: TermHandles, expectGen?: number): { cols: number; rows: number } | undefined {
  const skipped = fitSkipReason(h, expectGen);
  if (skipped) {
    logFitSkipped(skipped);
    return undefined;
  }
  try {
    h.fit.fit();
    const dims = h.fit.proposeDimensions() ?? undefined;
    if (!dims || !dims.cols || !dims.rows) {
      logFitSkipped("not-ready");
      return undefined;
    }
    return dims;
  } catch {
    logFitSkipped("exception");
    return undefined;
  }
}

/** 兼容保留：等价 fitSkipReason(h)===null，新代码走 guardedFit 统一入口。 */
export function isFitReady(h: TermHandles, expectGen?: number): boolean {
  return fitSkipReason(h, expectGen) === null;
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
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const kickOpenRef = useRef<(() => void) | null>(null);

  // 可见性翻转：唤醒 _deferredOpen（隐藏 tab 里不开，等可见+有尺寸再 open）
  useEffect(() => {
    if (visible) kickOpenRef.current?.();
  }, [visible]);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const host: HTMLDivElement = el;
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
    // guard v4：真凶在 term.open(el) 内部——xterm 自己构造 Viewport 时排 setTimeout→rAF，
    // 回调触发时 renderer 还没就绪或已被 dispose（_renderer.value undefined → get dimensions 炸）。
    // StrictMode 双挂载下 gen1 的内部 timer 不随 dispose 取消，我方代际守卫管不住 xterm 肚子里的。
    // 故：① open 前置守卫（isConnected + 可见 + 有尺寸）；② 单 flight（同一容器只 open 一次，
    // React 已保证 gen1 cleanup→dispose 先于 gen2 effect，_deferredOpen 可取消）；③ 孤儿遗言靠
    // logger.ts 精确签名兜底网转 debug。StrictMode 全局配置不动（dev 专属，prod 单挂载无此事）。
    if (!guardV4Logged) {
      guardV4Logged = true;
      console.info("[pty] guard v4 active");
    }
    const gen = ++ptyGenSeq;
    let cancelled = false;
    let opened = false;
    let disposed = false;
    let handles: TermHandles | null = null;
    let renderDisp: { dispose(): void } | null = null;
    let dataDisp: { dispose(): void } | null = null;
    let deferredRaf = 0;
    let deferredTimer = 0;
    let ro: ResizeObserver | null = null;
    const clearDeferred = () => {
      if (deferredRaf) window.cancelAnimationFrame(deferredRaf);
      if (deferredTimer) window.clearTimeout(deferredTimer);
      deferredRaf = 0;
      deferredTimer = 0;
    };
    const deferRetry = (delay = 60) => {
      if (cancelled || opened) return;
      clearDeferred();
      deferredRaf = window.requestAnimationFrame(() => {
        deferredRaf = 0;
        if (!cancelled && !opened) tryOpen();
      });
      deferredTimer = window.setTimeout(() => {
        deferredTimer = 0;
        if (!cancelled && !opened) tryOpen();
      }, delay);
    };
    const tryGuardedFit = () => {
      if (!handles || disposed) {
        logFitSkipped("disposed");
        return;
      }
      if (!host.isConnected) {
        logFitSkipped("disposed");
        return;
      }
      // PtyPane 本地首帧补 fit：失败只记 dirty 不抛，切 tab 可见时由父级 pendingFit 补 fit
      guardedFit(handles, gen);
    };
    function tryOpen() {
      if (cancelled || opened) return;
      // 单 flight：同一容器只 open 一次（防同代重复 open；gen1 残留由 cleanup 先 dispose）
      if (host.dataset.ptyOpened === "1" || host.querySelector(".xterm-screen")) {
        deferRetry(80);
        return;
      }
      // open 前置守卫：须挂载 + 可见 + 有尺寸（隐藏 tab 等可见再 open）
      if (!host.isConnected || !visibleRef.current) {
        logFitSkipped(host.isConnected ? "hidden" : "disposed");
        deferRetry(80);
        return;
      }
      if (host.clientWidth <= 0 || host.clientHeight <= 0) {
        logFitSkipped("hidden");
        deferRetry(80);
        return;
      }
      try {
        term.open(host);
      } catch (e) {
        // open 同步炸：精确签名才转 debug 重试（孤儿/首帧竞态），其余照常上报
        if (isOrphanViewportDimError(e)) {
          console.debug("[pty] guard v4: open deferred (orphan viewport race), retry when visible+sized");
          deferRetry(80);
          return;
        }
        throw e;
      }
      opened = true;
      clearDeferred();
      ro?.disconnect();
      host.dataset.ptyOpened = "1";
      const h: TermHandles = { term, fit, gen };
      handles = h;
      renderDisp = term.onRender(() => tryGuardedFit());
      deferredRaf = window.requestAnimationFrame(() => tryGuardedFit());
      dataDisp = term.onData((data) => cbRef.current.onUserInput(tabKey, data));
      cbRef.current.register(tabKey, h);
    }
    kickOpenRef.current = tryOpen;
    // 可见性/尺寸变化唤醒 _deferredOpen（rAF 轮询兜底 + RO 精确唤醒）
    try {
      ro = new ResizeObserver(() => {
        if (!cancelled && !opened) tryOpen();
      });
      ro.observe(host);
      if (host.parentElement) ro.observe(host.parentElement);
    } catch {
      ro = null;
    }
    tryOpen();
    return () => {
      cancelled = true;
      disposed = true;
      kickOpenRef.current = null;
      clearDeferred();
      ro?.disconnect();
      renderDisp?.dispose();
      dataDisp?.dispose();
      cbRef.current.unregister(tabKey);
      try {
        term.dispose();
      } catch {
        /* dispose best-effort：孤儿内部 timer 的遗言走 logger 兜底网 */
      }
      delete host.dataset.ptyOpened;
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
  /** deferred-open 期间（隐藏/0 尺寸未 open）的输出缓存，register 时 flush，不丢首屏 */
  const pendingWrites = useRef(new Map<number, string[]>());

  useEffect(() => {
    setCwdDraft(defaultCwd ?? "");
  }, [defaultCwd]);

  const gated = canOpenPath === false;
  const activeTab = tabs.find((t) => t.key === activeKey) ?? null;

  const fitAndResize = useCallback((key: number, expectGen?: number) => {
    const h = terms.current.get(key);
    const ptyId = ptyIdByKey.current.get(key);
    if (!h || !ptyId) return;
    // 代际短路：StrictMode 双挂载/重建后迟到 timer 打到新实例首帧即弃
    if (expectGen !== undefined && h.gen !== expectGen) {
      logFitSkipped("stale-generation");
      return;
    }
    // dispose 迟到短路：element 已摘除即已 dispose/关闭中，不调 fit
    try {
      if (!h.term.element?.isConnected) {
        logFitSkipped("disposed");
        pendingFit.current.add(key);
        return;
      }
    } catch {
      logFitSkipped("exception");
      pendingFit.current.add(key);
      return;
    }
    const tab = tabsRef.current.find((t) => t.key === key);
    if (!tab || tab.dead || tab.starting || tab.error) return;
    // 唯一读取入口：守卫 + try/catch 兜底记 dirty，失败待切 tab 可见补 fit（不断连）
    const dims = guardedFit(h, expectGen);
    if (!dims) {
      pendingFit.current.add(key);
      return;
    }
    pendingFit.current.delete(key);
    const cols = Math.max(1, Math.min(500, dims.cols));
    const rows = Math.max(1, Math.min(500, dims.rows));
    void pty.resize(ptyId, cols, rows).catch(() => {
      /* resize 失败不刷屏，终端仍可用 */
    });
  }, []);

  const scheduleFit = useCallback(
    (key: number, delay = 120, expectGen?: number) => {
      const prev = fitTimers.current.get(key);
      if (prev) window.clearTimeout(prev);
      const gen = expectGen ?? terms.current.get(key)?.gen;
      fitTimers.current.set(
        key,
        window.setTimeout(() => fitAndResize(key, gen), delay),
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
        // spawn 后按实际渲染尺寸校准一次（跟踪代际：迟到即弃，防打到重建实例首帧）
        scheduleFit(key, 60);
      } catch (e) {
        const msg = friendlyPtyError(e);
        setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, starting: false, error: msg } : t)));
        if (/上限\(4\)/.test(msg)) setGlobalError(msg);
      }
    },
    [scheduleFit],
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
    // 先清 fit 定时：防 dispose 后迟到 timer 触 proposeDimensions（_renderer.value 已空）
    const timer = fitTimers.current.get(key);
    if (timer) {
      window.clearTimeout(timer);
      fitTimers.current.delete(key);
    }    const id = ptyIdByKey.current.get(key);
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
    pendingWrites.current.delete(key);
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
      const h = terms.current.get(key);
      if (!h) {
        // deferred-open 未就绪：缓存（cap 64KB 防爆），register 时 flush
        const q = pendingWrites.current.get(key) ?? [];
        const size = q.reduce((n, s) => n + s.length, 0);
        if (size < 65536) {
          q.push(e.data);
          pendingWrites.current.set(key, q);
        }
        return;
      }
      h.term.write(e.data);
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
      pendingWrites.current.clear();
    };
  }, []);

  // 切 tab 后重 fit（隐藏→显示尺寸变化联动 resize；后台 tab 不断连，仅补尺寸）
  useEffect(() => {
    if (activeKey == null) return;
    const gen = terms.current.get(activeKey)?.gen;
    // rAF 待 display:none→flex layout 就绪后再 fit，60ms 定时兜底脏页（代际对不上即弃）
    const raf = window.requestAnimationFrame(() => fitAndResize(activeKey, gen));
    const t = window.setTimeout(() => fitAndResize(activeKey, gen), 60);
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
      // deferred-open 补齐：把等待期间的输出一次性刷屏
      const queued = pendingWrites.current.get(key);
      if (queued?.length) {
        pendingWrites.current.delete(key);
        try {
          for (const chunk of queued) h.term.write(chunk);
        } catch {
          /* flush best-effort */
        }
      }
      if (key === activeKey) scheduleFit(key, 120, h.gen);
      else {
        // 后台 tab 隐藏不断连：不可见时 fitAndResize 内记 dirty，切回时补 fit，不抛错（代际绑定防错位）
        scheduleFit(key, 80, h.gen);
      }
    },
    [activeKey, scheduleFit],
  );
  const unregister = useCallback((key: number) => {
    terms.current.delete(key);
    pendingFit.current.delete(key);
    pendingWrites.current.delete(key);
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
