import { DEFAULT_CONFIG, type WatchdogConfig } from "../src/config.js";
import { Engine, type AgentView, type EngineDeps } from "../src/engine.js";
import { MemoryKv } from "../src/kv.js";
import type { ModelSnapshot } from "../src/zen.js";

export const CO = "c0000000-0000-4000-8000-000000000001";
export const OC = "9d487375-7a73-429a-b31b-7a601ae49385";
export const CTO = "ca7c92dd-2c00-4811-ae20-dd3bb1782c1d";
export const T0 = Date.UTC(2026, 9, 18, 10, 0, 0);
export const SNAP: ModelSnapshot = { all: ["big-pickle", "glm-5.3-flash-free", "gpt-5.4"], free: ["big-pickle", "glm-5.3-flash-free"], fetchedAt: "2026-10-18T10:00:00.000Z" };

export const agent = (id: string, over: Partial<AgentView> = {}): AgentView =>
  ({ id, companyId: CO, name: id === OC ? "OpenCodeTest" : id === CTO ? "CTO" : id, adapterType: "opencode_local", adapterConfig: { model: "opencode/glm-5.3-flash-free" }, ...over });

export function mk(opts: { agents?: AgentView[]; cfg?: Partial<WatchdogConfig>; snap?: ModelSnapshot | null; issues?: Record<string, { status: string; originId?: string }> } = {}) {
  const agents = opts.agents ?? [agent(OC), agent(CTO, { adapterType: "claude_local", adapterConfig: {} })];
  const clock = { t: T0 };
  const writes: unknown[] = [];
  const reads = { snapshot: 0 };
  const logs: { msg: string; meta?: Record<string, unknown> }[] = [];
  const issues = { ...(opts.issues ?? {}) };
  const cfg = { ...DEFAULT_CONFIG, ...(opts.cfg ?? {}) };
  const kv = new MemoryKv();
  const deps: EngineDeps = {
    kv, cfg: () => cfg, now: () => clock.t,
    log: (msg, meta) => logs.push({ msg, meta }),
    metric: () => undefined,
    getAgent: async (id) => agents.find((a) => a.id === id) ?? null,
    listAgents: async () => agents,
    getIssue: async (id) => (issues[id] ? { id, ...issues[id] } : null),
    createIssue: async (input) => { writes.push(input); const id = `iss-${writes.length}`; issues[id] = { status: "todo", originId: input.originId }; return { id, identifier: `PLA-${writes.length}` }; },
    snapshot: async () => { reads.snapshot++; return opts.snap === undefined ? SNAP : opts.snap; },
  };
  return { engine: new Engine(deps), clock, writes, reads, logs, kv, issues };
}

export const failed = (over: Record<string, unknown> = {}) => ({
  companyId: CO,
  payload: { runId: "run-1", agentId: OC, status: "failed", errorCode: null, error: "Configured OpenCode model is unavailable: opencode/glm-5.3-flash-free", issueId: null, ...over },
});
