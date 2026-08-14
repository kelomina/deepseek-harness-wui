import { useCallback, useEffect, useState } from "react";
import { appStore } from "../lib/dsh/store";
import { Modal } from "./ui";

interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export function FolderBrowser({
  title,
  onPick,
  onClose,
}: {
  title: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const load = useCallback(async (p?: string) => {
    setError(null);
    try {
      const r = await appStore.listDirectory(p);
      if (r.result.ok) {
        setPath(r.result.value.path ?? null);
        setEntries((r.result.value.entries ?? []) as DirectoryEntry[]);
      } else {
        setError(`${r.result.error.code}: ${r.result.error.message}`);
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load(undefined);
  }, [load]);

  const goUp = () => {
    if (!path) return;
    const parent = path.replace(/[\\/]+$/, "");
    const cut = Math.max(parent.lastIndexOf("\\"), parent.lastIndexOf("/"));
    void load(cut > 0 ? parent.slice(0, cut) : "");
  };

  const createDir = async () => {
    if (!path || !newName.trim()) return;
    try {
      const r = await appStore.createDirectory(path, newName.trim());
      if (r.result.ok) {
        setNewName("");
        void load(path);
      } else {
        setError(`${r.result.error.code}: ${r.result.error.message}`);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn subtle" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!path} onClick={() => path && onPick(path)}>
            选择此目录
          </button>
        </>
      }
    >
      <div className="field">
        <label>当前目录</label>
        <div className="input" style={{ fontFamily: "Consolas, monospace", fontSize: 12 }}>{path ?? "加载中…"}</div>
      </div>
      {error && <div className="error-banner" style={{ margin: 0, marginBottom: 8 }}>{error}</div>}
      <div className="list" style={{ minHeight: 180, border: "1px solid var(--stroke-2)", borderRadius: 6, padding: 4 }}>
        {path && (
          <div className="folder-row" onClick={goUp}>
            <span>📁</span>
            <span className="name">.. (上级)</span>
          </div>
        )}
        {entries.map((d) => (
          <div className="folder-row" key={d.path} onClick={() => void load(d.path)}>
            <span>📁</span>
            <span className="name">{d.name}</span>
          </div>
        ))}
        {entries.length === 0 && <div className="empty-state">（没有子目录）</div>}
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label>新建文件夹</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="input" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} placeholder="名称" />
          <button className="btn" onClick={() => void createDir()}>新建</button>
        </div>
      </div>
    </Modal>
  );
}
