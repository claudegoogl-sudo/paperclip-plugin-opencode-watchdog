import type { WatchdogConfig } from "./config.js";
import { compilePatterns, isTimeout, matchModelError, sanitizeError } from "./detect.js";
import type { Kv } from "./kv.js";
import { classifyModel, type ModelSnapshot } from "./zen.js";

export const ORIGIN_KIND = "plugin:platform.opencode-watchdog";
export const ORIGIN_PREFIX = "opencode-watchdog:";
const TERMINAL = new Set(["done", "cancelled"]);

export interface AgentView { id: string; companyId: string; name: string; adapterType: string; adapterConfig: Record<string, unknown> }
export interface IssueView { id: string; status: string; originId?: string | null; originKind?: string | null }
export interface RunFailedEvent { companyId: string; payload: Record<string, unknown> }

export interface EngineDeps {
  kv: Kv;
  cfg: () => WatchdogConfig;
  now: () => number;
  log: (msg: string, meta?: Record<string, unknown>) => void;
  metric: (name: string, tags?: Record<string, string>) => void;
  getAgent(id: string, companyId: string): Promise<AgentView | null>;
  listAgents(companyId: string): Promise<AgentView[]>;
  getIssue(id: string, companyId: string): Promise<IssueView | null>;
  createIssue(input: { companyId: string; title: string; description: string; priority: "high"; assigneeAgentId: string; originKind: string; originId: string }): Promise<{ id: string; identifier?: string | null }>;
  /** Free-model snapshot, or null when unavailable. */
  snapshot(): Promise<ModelSnapshot | null>;
}

export interface AgentState { companyId: string; lastRescueAt: number; rescueIssueId: string | null; previousModel: string | null; reason: string }
export type Outcome =
  | { action: "created"; issueId: string; reason: string }
  | { action: "dry_run"; reason: string }
  | { action: "skipped"; why: string };

const STATE_KEY = "agents";
const hourBucket = (now: number, hours: number) => Math.floor(now / (hours * 3_600_000));

export class Engine {
  private inflight = new Set<string>();
  constructor(private d: EngineDeps) {}

  private skip(why: string, meta: Record<string, unknown> = {}): Outcome {
    this.d.log("opencode_watchdog.skipped", { why, ...meta });
    return { action: "skipped", why };
  }

  async states(): Promise<Record<string, AgentState>> {
    return (await this.d.kv.get<Record<string, AgentState>>(STATE_KEY)) ?? {};
  }

  /** Event path: `agent.run.failed`. Zero writes unless the failure is a model-unavailable error on a watched agent. */
  async onRunFailed(ev: RunFailedEvent): Promise<Outcome> {
    const cfg = this.d.cfg();
    const p = ev.payload ?? {};
    const agentId = typeof p.agentId === "string" ? p.agentId : null;
    if (!agentId || !ev.companyId) return this.skip("no_agent");
    if (cfg.agentAllowlist.length && !cfg.agentAllowlist.includes(agentId)) return this.skip("not_allowlisted", { agentId });
    if (cfg.rescueAgentId && agentId === cfg.rescueAgentId) return this.skip("rescue_agent_run", { agentId });
    const agent = await this.d.getAgent(agentId, ev.companyId);
    if (!agent) return this.skip("agent_not_found", { agentId });
    if (agent.adapterType !== "opencode_local") return this.skip("not_opencode", { agentId });
    const text = `${p.errorCode ?? ""}\n${p.error ?? ""}`;
    const matched = matchModelError(text, compilePatterns(cfg.errorPatterns));
    const timeout = !matched && isTimeout(p.errorCode, p.error);
    if (!matched && !timeout) return this.skip("not_model_error", { agentId });
    // Loop guard: a failing run that belongs to a rescue issue must never raise another rescue.
    if (typeof p.issueId === "string") {
      const iss = await this.d.getIssue(p.issueId, ev.companyId);
      if (iss?.originId?.startsWith(ORIGIN_PREFIX)) return this.skip("rescue_issue_run", { agentId, issueId: p.issueId });
    }
    return this.rescue(agent, {
      reason: timeout ? "timeout_suspect" : "run_failed",
      runId: typeof p.runId === "string" ? p.runId : null,
      error: sanitizeError(String(p.error ?? p.errorCode ?? ""), cfg.maxErrorChars),
      matched,
    });
  }

  /** Daily check (flag-gated). Read-only when healthy: one model-list GET, nothing else. */
  async proactive(companyIds: string[]): Promise<Outcome[]> {
    const cfg = this.d.cfg();
    if (!cfg.proactiveEnabled) return [];
    const snap = await this.d.snapshot();
    if (!snap) { this.d.log("opencode_watchdog.proactive_list_unavailable"); return []; }
    const out: Outcome[] = [];
    let checked = 0;
    for (const companyId of companyIds) {
      for (const a of await this.d.listAgents(companyId)) {
        if (a.adapterType !== "opencode_local") continue;
        if (cfg.agentAllowlist.length && !cfg.agentAllowlist.includes(a.id)) continue;
        checked++;
        const health = classifyModel(a.adapterConfig?.model, snap);
        if (health === "ok" || health === "out_of_scope") continue;
        out.push(await this.rescue(a, { reason: `proactive_${health}`, runId: null, error: `Configured model ${String(a.adapterConfig?.model)} is ${health === "removed" ? "no longer served by Zen" : "no longer free"}.`, matched: null }, snap));
      }
    }
    if (out.length === 0) this.d.log("opencode_watchdog.proactive_healthy", { checked, free: snap.free.length });
    return out;
  }

  private async rescue(agent: AgentView, info: { reason: string; runId: string | null; error: string; matched: string | null }, known?: ModelSnapshot): Promise<Outcome> {
    const cfg = this.d.cfg();
    const now = this.d.now();
    if (this.inflight.has(agent.id)) return this.skip("in_flight", { agentId: agent.id });
    this.inflight.add(agent.id);
    try {
      const state = (await this.states())[agent.id];
      if (state && now - state.lastRescueAt < cfg.debounceHours * 3_600_000) return this.skip("debounced", { agentId: agent.id });
      if (state?.rescueIssueId) {
        const open = await this.d.getIssue(state.rescueIssueId, agent.companyId);
        if (open && !TERMINAL.has(open.status)) return this.skip("rescue_open", { agentId: agent.id, issueId: state.rescueIssueId });
      }
      const rescuer = await this.resolveRescuer(agent.companyId);
      if (!rescuer) return this.skip("no_rescue_agent", { agentId: agent.id });
      if (rescuer === agent.id) return this.skip("rescue_agent_is_failing_agent", { agentId: agent.id });
      const snap = known ?? (await this.d.snapshot());
      const model = typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : null;
      const bucket = hourBucket(now, cfg.debounceHours);
      const originId = `${ORIGIN_PREFIX}${agent.id}:${bucket}`;
      const description = renderBody({ agent, model, info, snap, rescuer, originId });
      const title = `Rescue: opencode model unavailable for ${agent.name} (${model ?? "no model set"})`;
      if (cfg.dryRun) {
        this.d.log("opencode_watchdog.dry_run", { agentId: agent.id, reason: info.reason, title });
        return { action: "dry_run", reason: info.reason };
      }
      const created = await this.d.createIssue({ companyId: agent.companyId, title, description, priority: "high", assigneeAgentId: rescuer, originKind: ORIGIN_KIND, originId });
      const all = await this.states();
      all[agent.id] = { companyId: agent.companyId, lastRescueAt: now, rescueIssueId: created.id, previousModel: model, reason: info.reason };
      await this.d.kv.set(STATE_KEY, all);
      this.d.log("opencode_watchdog.rescue_created", { agentId: agent.id, issueId: created.id, runId: info.runId, reason: info.reason });
      this.d.metric("opencode_watchdog.rescue_created", { reason: info.reason });
      return { action: "created", issueId: created.id, reason: info.reason };
    } finally {
      this.inflight.delete(agent.id);
    }
  }

  private async resolveRescuer(companyId: string): Promise<string | null> {
    const cfg = this.d.cfg();
    if (cfg.rescueAgentId) return cfg.rescueAgentId;
    const want = cfg.rescueAgentName.toLowerCase();
    return (await this.d.listAgents(companyId)).find((a) => a.name.toLowerCase() === want)?.id ?? null;
  }
}

export function renderBody(i: {
  agent: AgentView; model: string | null; rescuer: string; originId: string;
  info: { reason: string; runId: string | null; error: string; matched: string | null }; snap: ModelSnapshot | null;
}): string {
  const meta = { agentId: i.agent.id, agentName: i.agent.name, previousModel: i.model, runId: i.info.runId, reason: i.info.reason, rescueKey: i.originId };
  const free = i.snap ? i.snap.free.map((m) => `- \`opencode/${m}\``).join("\n") : "_Zen model list unavailable at event time. Fetch it yourself (see step 1)._";
  return [
    `Automatic rescue request from the opencode free-model watchdog. Reason: **${i.info.reason}**.`,
    "",
    "## Facts",
    `- Agent: ${i.agent.name} (\`${i.agent.id}\`), adapter \`opencode_local\``,
    `- Current model: \`${i.model ?? "(none)"}\``,
    `- Failed run: ${i.info.runId ? `\`${i.info.runId}\`` : "n/a (proactive check)"}`,
    "- Error (truncated, redacted):",
    "```text",
    i.info.error || "(empty)",
    "```",
    "",
    `## Free models served by Zen now${i.snap ? ` (snapshot ${i.snap.fetchedAt}, ${i.snap.free.length} of ${i.snap.all.length})` : ""}`,
    free,
    "",
    ...(i.info.reason === "timeout_suspect"
      ? ["> **Timeout suspect.** The run hit its timeout; a removed model makes `opencode run` hang. This may be a false alarm. First check the Zen list above: if the configured model is still free, close this issue with no change.", ""]
      : []),
    "## Rescue instructions (CTO, Sonnet; never Opus)",
    "1. If the list above is missing, read it: `GET https://opencode.ai/zen/v1/models`. Free = id ends in `-free`, or `big-pickle`, or cost 0 in https://models.dev/api.json (provider `opencode`).",
    "2. Pick the best currently-free model: same family and size as the current one if possible, tool-use capable.",
    "3. `PATCH /api/agents/<agentId>` and change ONLY `adapterConfig.model` (send the full existing adapterConfig with the one field changed). Touch only the affected agent.",
    "4. If no free model fits, set the agent to `claude_local` with model `claude-sonnet-5-5` instead.",
    "5. `GET` the agent again and diff before/after. Post the diff proving only that field changed.",
    "6. The previous model is recorded by the plugin (`previousModel` in its state, also in the JSON below). To roll back: `node scripts/restore-model.mjs --agent <agentId> --state-file <state.json> --apply`.",
    "7. Post an operator comment that starts with `[[operator-deliver]]` and ends with the footer `— CTO · <ISSUE-KEY>`.",
    "",
    "<details><summary>machine-readable</summary>",
    "",
    "```json",
    JSON.stringify(meta, null, 2),
    "```",
    "</details>",
  ].join("\n");
}
