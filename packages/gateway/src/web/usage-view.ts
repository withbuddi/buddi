/**
 * Token usage as the dashboard is handed it: the `run.finished` payload's
 * `usage`, read defensively. The cache counts are present only when non-zero,
 * so a run on a provider that caches nothing reads exactly as it always did.
 * `input` excludes the cached tokens (see the runtime's `Usage.input`).
 */
export interface UsageView {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export function usageView(raw: unknown): UsageView {
  const u = (raw ?? {}) as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
  const cacheRead = Number(u.cacheRead ?? 0) || 0;
  const cacheWrite = Number(u.cacheWrite ?? 0) || 0;
  return {
    input: Number(u.input ?? 0),
    output: Number(u.output ?? 0),
    ...(cacheRead > 0 ? { cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
  };
}

export function addUsage(a: UsageView, b: UsageView): UsageView {
  return usageView({
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
  });
}
