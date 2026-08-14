import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let un: (() => void) | undefined;
    void win.isMaximized().then(setMaximized);
    void win
      .onResized(() => {
        void win.isMaximized().then(setMaximized);
      })
      .then((u) => {
        un = u;
      });
    return () => {
      un?.();
    };
  }, []);
  const win = getCurrentWindow();
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="tb-group">
        <span className="menu-item">文件(F)</span>
        <span className="menu-item">编辑(E)</span>
        <span className="menu-item">视图(V)</span>
      </div>
      <div className="tb-group">
        <button className="win-btn" title="最小化" aria-label="最小化" onClick={() => void win.minimize()}>–</button>
        <button className="win-btn" title={maximized ? "还原" : "最大化"} aria-label="最大化/还原" onClick={() => void win.toggleMaximize()}>
          {maximized ? "❐" : "□"}
        </button>
        <button className="win-btn close" title="关闭" aria-label="关闭" onClick={() => void win.close()}>×</button>
      </div>
    </header>
  );
}
