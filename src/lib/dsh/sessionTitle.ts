import type { SessionSummary } from "@deepseek-ai/dsh-host-apiproxy/api";

export function sessionTitle(s: SessionSummary): string | null {
  const p = s.projections as Record<string, { value?: unknown }> | undefined;
  if (p) {
    for (const key of Object.keys(p)) {
      const v = p[key]?.value;
      if (typeof v === "string" && v) return v;
    }
  }
  return null;
}
