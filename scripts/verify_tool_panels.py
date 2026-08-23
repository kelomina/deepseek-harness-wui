# -*- coding: utf-8 -*-
"""ToolDock 前端交互链路验证（纯浏览器 + __TAURI_INTERNALS__ mock）。
用法：先 `npm run dev` 起 Vite（1420 端口），再 `python scripts/verify_tool_panels.py`。
截图与报告输出到脚本同级目录。"""
import json
import os
from playwright.sync_api import sync_playwright

OUT = os.path.dirname(os.path.abspath(__file__))
URL = "http://127.0.0.1:1420/"

MOCK_JS = r"""
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: (cb) => { window.__tauriCb = cb; return 1; },
  unregisterCallback: () => {},
  convertFileSrc: (p) => p,
  invoke: async (cmd, args) => {
    switch (cmd) {
      case "dsh_status": return { state: "stopped", pid: null, port: 4199, proxy_port: 0, message: "mock", uptime_secs: null, auto_start: false, proxy_used: null };
      case "dsh_get_config": return { exec_mode: "bundled", exec_path: null, port: 4199, dsh_home: null, workspace_dir: null, auto_start: false, startup_timeout_secs: 30, max_restarts: 3, restart_window_secs: 60, health_interval_secs: 5, log_max_lines: 500, proxy_enabled: false, proxy_url: null, selected_provider: null, selected_model: null, selected_reasoning: null, managed_runtime_version: null, wsl_default_distro: null, wsl_dsh_home: null, wsl_workspace_dir: null };
      case "dsh_get_logs": return [];
      case "plugin:event|listen": return 1;
      case "plugin:event|unlisten": return null;
      case "plugin:window|is_maximized": return false;
      case "plugin:window|minimize": return null;
      case "plugin:window|toggle_maximize": return null;
      case "plugin:window|close": return null;
      case "fs_list_dir": return { path: "C:\\Users\\Saika", entries: [ { name: "Documents", path: "C:\\Users\\Saika\\Documents", hidden: false }, { name: "Projects", path: "C:\\Users\\Saika\\Projects", hidden: false }, { name: ".cache", path: "C:\\Users\\Saika\\.cache", hidden: true } ] };
      case "term_exec": return { output: "hello_wui\n", exit_code: 0 };
      case "web_fetch": { const r = await fetch(args.url); return { status: r.status, body: (await r.text()).slice(0, 500) }; }
      case "git_status": return [ { path: "src/components/ToolViews.tsx", staged: " ", unstaged: "M" }, { path: "src/components/ToolDock.tsx", staged: "A", unstaged: " " } ];
      case "git_diff_file": return "--- a/ToolViews.tsx\n+++ b/ToolViews.tsx\n@@ -1,2 +1,3 @@\n line1\n+line2_added_by_mock\n line3";
      case "git_stage": return "";
      case "git_unstage": return "";
      case "git_commit": return "[main abc1234] mock commit";
      default: return null;
    }
  },
};
"""

results = []
console_errors = []


def check(name, ok, detail=""):
    results.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS" if ok else "FAIL"), "-", name, ("| " + detail if detail else ""))


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx.add_init_script(MOCK_JS)
    page = ctx.new_page()
    page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: console_errors.append(f"console[{m.type}]: {m.text}") if m.type == "error" else None)

    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1500)

    # 1. 欢迎页 + 汉堡按钮
    hb = page.locator(".hamburger-btn")
    check("1 欢迎页渲染且汉堡按钮存在", hb.count() == 1)
    page.screenshot(path=os.path.join(OUT, "01_welcome.png"))

    # 2. 菜单 4 项
    hb.click()
    page.wait_for_timeout(300)
    labels = [t.strip() for t in page.locator(".hm-label").all_text_contents()]
    check("2 菜单含4个工具项", labels == ["文件管理器", "终端（命令行）", "浏览器", "Git"], str(labels))
    page.screenshot(path=os.path.join(OUT, "02_menu.png"))

    # 3. 打开终端 tab + 布局核对
    page.locator(".hm-item", has_text="终端").click()
    page.wait_for_timeout(500)
    dock = page.locator(".tool-dock")
    check("3a ToolDock 面板出现", dock.count() == 1)
    inner_head = dock.locator(".tools-head").count()
    inner_tabs = dock.locator(".tools-tabs").count()
    check("3b 无双tab栏（内部无工具标题/第二排tab）", inner_head == 0 and inner_tabs == 0,
          f"tools-head={inner_head}, tools-tabs={inner_tabs}")
    dock_box = dock.bounding_box()
    view_box = page.locator(".view.active").bounding_box()
    ratio = dock_box["height"] / view_box["height"] if view_box and dock_box else 0
    check("3c 面板高度撑满视图(>85%)", ratio > 0.85, f"ratio={ratio:.2f}")
    check("3d 终端tab选中且含命令输入区",
          dock.locator(".td-tabs .t-tab.on", has_text="终端").count() == 1
          and dock.locator(".tp-cmd").count() >= 1)
    page.screenshot(path=os.path.join(OUT, "03_terminal_layout.png"))

    # 4. 终端执行
    dock.locator(".tp-cmd").first.fill("echo hello_wui")
    dock.locator("button", has_text="执行").first.click()
    page.wait_for_timeout(600)
    card_text = dock.locator(".toolcard").first.text_content() or ""
    check("4 终端执行记录卡片", "echo hello_wui" in card_text and "exit 0" in card_text and "hello_wui" in card_text,
          card_text[:120])
    page.screenshot(path=os.path.join(OUT, "04_term_exec.png"))

    # 5. 浏览器抓取（真实 fetch 本地 Vite）
    dock.locator(".td-tabs .t-tab", has_text="浏览器").click()
    page.wait_for_timeout(300)
    dock.locator(".tp-cmd").first.fill(URL)
    dock.locator("button", has_text="抓取").first.click()
    page.wait_for_timeout(1200)
    web_text = dock.locator(".toolcard").first.text_content() or ""
    check("5 浏览器抓取本地服务 HTTP 200", "HTTP 200" in web_text, web_text[:150])
    page.screenshot(path=os.path.join(OUT, "05_web_fetch.png"))

    # 6. Git 刷新 + diff
    dock.locator(".td-tabs .t-tab", has_text="Git").click()
    page.wait_for_timeout(300)
    dock.locator(".tp-cmd").first.fill("e:\\Project\\HTML\\DeepSeekHarnessWUI")
    dock.locator("button", has_text="刷新").first.click()
    page.wait_for_timeout(600)
    cards = dock.locator(".toolcard")
    git_ok = cards.count() == 2
    check("6a Git 刷新出2个文件卡片", git_ok, f"count={cards.count()}")
    first = cards.first.text_content() or ""
    check("6b M徽标+暂存按钮", "M" in first and "暂存" in first, first[:120])
    cards.first.locator("button", has_text="diff").click()
    page.wait_for_timeout(400)
    diff_text = dock.locator(".toolcard-output").first.text_content() or ""
    check("6c diff 展开含 +line2_added_by_mock", "+line2_added_by_mock" in diff_text, diff_text[:120])
    page.screenshot(path=os.path.join(OUT, "06_git.png"))

    # 7. 文件 tab
    dock.locator(".td-tabs .t-tab", has_text="文件").click()
    page.wait_for_timeout(500)
    file_text = dock.locator(".td-body").text_content() or ""
    check("7 文件tab目录浏览", "Documents" in file_text and ".cache" in file_text and "隐藏" in file_text
          and "会话涉及文件" in file_text, file_text[:150])
    page.screenshot(path=os.path.join(OUT, "07_files.png"))

    # 8. 关闭面板
    dock.locator(".td-close").click()
    page.wait_for_timeout(300)
    check("8 关闭按钮使面板消失", page.locator(".tool-dock").count() == 0)
    page.screenshot(path=os.path.join(OUT, "08_closed.png"))

    browser.close()

real_errors = [e for e in console_errors if "favicon" not in e and "DevTools" not in e]
check("9 控制台无未捕获异常", len(real_errors) == 0, "; ".join(real_errors[:5]))

with open(os.path.join(OUT, "report.json"), "w", encoding="utf-8") as f:
    json.dump({"results": results, "console_errors": console_errors}, f, ensure_ascii=False, indent=2)

failed = [r for r in results if not r["ok"]]
print(f"\nTOTAL {len(results)} / FAILED {len(failed)}")
