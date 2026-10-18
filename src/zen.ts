export type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ModelSnapshot {
  /** Every model id Zen currently serves. */
  all: string[];
  /** Subset that is free: id ends in `-free`, is `big-pickle`, or has cost 0 in the catalog. */
  free: string[];
  fetchedAt: string;
}

const ALWAYS_FREE = new Set(["big-pickle"]);

/**
 * Read-only: one GET to the Zen model list (+ one optional GET to the public catalog). No auth, no LLM call.
 * Returns null on any failure so callers never act on a bad snapshot.
 */
export async function fetchModelSnapshot(
  fetcher: Fetcher,
  opts: { zenUrl: string; catalogUrl: string | null; now: () => number },
): Promise<ModelSnapshot | null> {
  try {
    const res = await fetcher(opts.zenUrl);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const all = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    if (all.length === 0) return null;
    const zeroCost = new Set<string>();
    if (opts.catalogUrl) {
      try {
        const c = await fetcher(opts.catalogUrl);
        if (c.ok) {
          const cat = (await c.json()) as Record<string, { models?: Record<string, { cost?: { input?: number; output?: number } }> }>;
          for (const [id, m] of Object.entries(cat.opencode?.models ?? {})) if (m.cost && m.cost.input === 0 && m.cost.output === 0) zeroCost.add(id);
        }
      } catch { /* catalog is optional */ }
    }
    const free = all.filter((id) => id.endsWith("-free") || ALWAYS_FREE.has(id) || zeroCost.has(id));
    return { all: [...all].sort(), free: [...free].sort(), fetchedAt: new Date(opts.now()).toISOString() };
  } catch {
    return null;
  }
}

/** "opencode/glm-5.3-flash-free" -> "glm-5.3-flash-free". Non-Zen models -> null (out of scope). */
export function zenModelId(model: unknown): string | null {
  return typeof model === "string" && model.startsWith("opencode/") ? model.slice("opencode/".length) : null;
}

export type ModelHealth = "ok" | "removed" | "no_longer_free";
export function classifyModel(model: unknown, snap: ModelSnapshot): ModelHealth | "out_of_scope" {
  const id = zenModelId(model);
  if (!id) return "out_of_scope";
  if (!snap.all.includes(id)) return "removed";
  return snap.free.includes(id) ? "ok" : "no_longer_free";
}
