import { useEffect, useRef } from "react";
import { useAppState } from "../lib/dsh/store";

export function LogPanel() {
  const logs = useAppState().logs;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs.length]);
  return (
    <div className="log-panel" ref={ref}>
      {logs.length === 0 ? "(暂无日志)" : logs.join("\n")}
    </div>
  );
}
