import { useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import type { ModelProviderGroup } from "@deepseek-ai/dsh-host-apiproxy/api";

export function ModelMenu({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<ModelProviderGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { selectedModel, host } = useAppState();

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && groups === null) {
      setLoading(true);
      try {
        setGroups(await appStore.listModels());
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    }
  };

  let label = host?.model ?? "选择模型";
  if (selectedModel) {
    const g = groups?.find((x) => x.id === selectedModel.provider);
    const m = g?.models.find((x) => x.id === selectedModel.model);
    label = m?.name ?? selectedModel.model;
  }

  return (
    <div style={{ position: "relative" }}>
      <button className="model-btn" title="选择模型" onClick={() => void toggle()}>
        <span className="name">{label}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 90 }} onClick={() => setOpen(false)} />
          <div className="model-menu">
            {loading && <div className="muted" style={{ padding: 8 }}>加载中…</div>}
            {error && <div className="muted" style={{ padding: 8, color: "var(--red)" }}>{error}</div>}
            {groups && groups.length === 0 && <div className="muted" style={{ padding: 8 }}>没有可用模型</div>}
            {groups?.map((g) => (
              <div key={g.id}>
                <div className="mm-group">{g.name}</div>
                {g.models.map((m) => (
                  <button
                    key={m.id}
                    className={`mm-item${selectedModel?.provider === g.id && selectedModel.model === m.id ? " active" : ""}`}
                    onClick={() => {
                      appStore.setSelectedModel({ provider: g.id, model: m.id });
                      setOpen(false);
                    }}
                  >
                    {m.name}
                    <span className="mm-id">{m.id}</span>
                  </button>
                ))}
              </div>
            ))}
            {onOpenSettings && (
              <div className="mm-foot">
                <button className="link" onClick={() => { setOpen(false); onOpenSettings(); }}>管理提供商…</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
