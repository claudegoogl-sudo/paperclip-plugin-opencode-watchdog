import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, parseConfig, type WatchdogConfig } from "./config.js";
import { Engine, type AgentView, type IssueView } from "./engine.js";
import { stateKv } from "./kv.js";
import { JOBS } from "./manifest.js";
import { fetchModelSnapshot, type Fetcher } from "./zen.js";

type Rec = Record<string, unknown>;
let engine: Engine | null = null;
let cfgRef: WatchdogConfig = DEFAULT_CONFIG;

const toAgent = (a: unknown): AgentView | null => {
  const r = a as Rec | null;
  if (!r) return null;
  return { id: String(r.id), companyId: String(r.companyId), name: String(r.name ?? ""), adapterType: String(r.adapterType ?? ""), adapterConfig: (r.adapterConfig as Rec) ?? {} };
};

/** Per-company config row if the host has one, else instance config, else safe defaults. */
async function loadConfig(ctx: PluginContext, companyId?: string): Promise<WatchdogConfig> {
  for (const read of [
    companyId ? () => ctx.config.getForServiceScope(companyId) : null,
    () => ctx.config.get(),
  ]) {
    if (!read) continue;
    try { return (cfgRef = parseConfig(await read())); } catch { /* try next */ }
  }
  return cfgRef;
}

const plugin = definePlugin({
  async setup(ctx) {
    const fetcher = ctx.http.fetch.bind(ctx.http) as unknown as Fetcher;
    engine = new Engine({
      kv: stateKv(ctx),
      cfg: () => cfgRef,
      now: () => Date.now(),
      log: (msg, meta) => ctx.logger.info(msg, meta),
      metric: (name, tags) => void ctx.metrics.write(name, 1, tags).catch(() => undefined),
      getAgent: async (id, companyId) => toAgent(await ctx.agents.get(id, companyId)),
      listAgents: async (companyId) => ((await ctx.agents.list({ companyId, limit: 500 })) as unknown[]).map(toAgent).filter((a): a is AgentView => !!a),
      getIssue: async (id, companyId) => {
        const i = (await ctx.issues.get(id, companyId)) as Rec | null;
        return i ? ({ id: String(i.id), status: String(i.status), originId: (i.originId as string) ?? null, originKind: (i.originKind as string) ?? null } satisfies IssueView) : null;
      },
      createIssue: async (input) => {
        const i = (await ctx.issues.create({ ...input, originKind: input.originKind as `plugin:${string}` })) as unknown as Rec;
        return { id: String(i.id), identifier: (i.identifier as string) ?? null };
      },
      snapshot: () => fetchModelSnapshot(fetcher, { zenUrl: cfgRef.zenModelsUrl, catalogUrl: cfgRef.modelsDevUrl, now: () => Date.now() }),
    });
    const eng = engine;
    ctx.logger.info("opencode_watchdog.started", { trigger: "agent.run.failed" });

    ctx.events.on("agent.run.failed", async (e) => {
      if (!e.companyId) return;
      try {
        await loadConfig(ctx, e.companyId);
        await eng.onRunFailed({ companyId: e.companyId, payload: (e.payload ?? {}) as Rec });
      } catch (err) {
        ctx.logger.warn("opencode_watchdog.handler_error", { error: (err as Error)?.name ?? "Error" });
      }
    });

    ctx.jobs.register(JOBS.modelCheck, async () => {
      const ids: string[] = [];
      let enabled = false;
      for (const c of (await ctx.companies.list({ limit: 500 })) as unknown as Rec[]) {
        try { if ((await loadConfig(ctx, String(c.id))).proactiveEnabled) enabled = true; ids.push(String(c.id)); } catch { /* not configured */ }
      }
      if (!enabled) return; // flag off: silent exit, no reads, no writes
      await eng.proactive(ids);
    });
  },
  async onApiRequest(input) {
    if (!engine || input.routeKey !== "state") return { status: 404, body: { error: "not_found" } };
    return { status: 200, body: { agents: Object.fromEntries(Object.entries(await engine.states()).filter(([, v]) => v.companyId === input.companyId)) } };
  },
  async onHealth() {
    return { status: "ok", details: { agentsTracked: engine ? Object.keys(await engine.states()).length : 0 } };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
