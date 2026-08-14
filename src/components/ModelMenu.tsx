import { useState } from "react";
import { appStore, useAppState } from "../lib/dsh/store";
import type { ModelProviderGroup } from "@deepseek-ai/dsh-host-apiproxy/api";

export function ModelMenu({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<ModelProviderGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { selectedModel, host, modelGroups } = useAppState();

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      const source = groups ?? modelGroups;
      if (source) {
        setGroups(source);
      } else {
        setLoading(true);
        try {
          const list = await appStore.listModels();
          setGroups(list);
          appStore.set({ modelGroups: list });
        } catch (e) {
          setError(String(e));
        } finally {
          setLoading(false);
        }
      }
    }
  };

  const catalog = groups ?? modelGroups;
  const findName = (provider: string, model: string): string | undefined => {
    const g = catalog?.find((x) => x.id === provider);
    return g?.models.find((x) => x.id === model)?.name;
  };
  let label = "选择模型";
  if (selectedModel) {
    label = `${selectedModel.provider} · ${findName(selectedModel.provider, selectedModel.model) ?? selectedModel.model}`;
  } else if (host?.model) {
    label = `${host.provider ?? ""} · ${findName(host.provider ?? "", host.model) ?? host.model}`;
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
            {catalog && catalog.length === 0 && <div className="muted" style={{ padding: 8 }}>没有可用模型</div>}
            {catalog?.map((g) => (
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


