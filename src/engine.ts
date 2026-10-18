import type { WatchdogConfig } from "./config.js";
import { compilePatterns, isTimeout, matchModelError, sanitizeError } from "./detect.js";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
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
  createIssue(input: { companyId: string; title: string; description: string; priority: "high" | "medium"; status: "todo"; assigneeAgentId: string; parentId?: string; originKind: string; originId: string }): Promise<{ id: string; identifier?: string | null }>;
  /** Free-model snapshot, or null when unavailable. */
  snapshot(): Promise<ModelSnapshot | null>;
}

export interface AgentState { companyId: string; lastRescueAt: number; rescueIssueId: string | null; previousModel: string | null; reason: string }
export type Outcome =
  | { action: "created"; issueId: string; reason: string }
  | { action: "dry_run"; reason: string }
  | { action: "skipped"; why: string };

const STATE_KEY = "agents";
const FREE_KEY = "freeModels";
const BENCH_KEY = "benchmarkIssue";
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
    if (cfg.agentDenylist.includes(agentId)) return this.skip("denylist", { agentId });
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
      failedIssueId: typeof p.issueId === "string" ? p.issueId : null,
    });
  }

  /** Daily check (flag-gated). Read-only when healthy: one model-list GET, nothing else. */
  async proactive(companyIds: string[], known?: ModelSnapshot | null): Promise<Outcome[]> {
    const cfg = this.d.cfg();
    if (!cfg.proactiveEnabled) return [];
    const snap = known ?? (await this.d.snapshot());
    if (!snap) { this.d.log("opencode_watchdog.proactive_list_unavailable"); return []; }
    const out: Outcome[] = [];
    let checked = 0;
    for (const companyId of companyIds) {
      for (const a of await this.d.listAgents(companyId)) {
        if (a.adapterType !== "opencode_local") continue;
        if (cfg.agentDenylist.includes(a.id)) { this.d.log("opencode_watchdog.skipped", { why: "denylist", agentId: a.id }); continue; }
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

  /** Daily new-free-model diff (flag-gated). Healthy = one GET, zero writes. */
  async newModels(companyId: string, known?: ModelSnapshot | null): Promise<Outcome> {
    const cfg = this.d.cfg();
    if (!cfg.newModelWatchEnabled) return { action: "skipped", why: "disabled" };
    const snap = known ?? (await this.d.snapshot());
    if (!snap) { this.d.log("opencode_watchdog.new_model_list_unavailable"); return { action: "skipped", why: "list_unavailable" }; }
    const current = [...new Set(snap.free)].sort();
    const base = await this.d.kv.get<string[]>(FREE_KEY);
    if (!Array.isArray(base)) {
      if (cfg.dryRun) { this.d.log("opencode_watchdog.dry_run", { what: "new_model_baseline_seed", free: current.length }); return { action: "dry_run", reason: "baseline_seed" }; }
      await this.d.kv.set(FREE_KEY, current);
      this.d.log("opencode_watchdog.new_model_baseline_seeded", { free: current.length });
      return { action: "skipped", why: "baseline_seeded" };
    }
    const known0 = new Set(base);
    const added = current.filter((id) => !known0.has(id));
    const removed = base.filter((id) => !current.includes(id));
    if (removed.length) this.d.log("opencode_watchdog.free_models_removed", { removed });
    if (added.length === 0) {
      if (removed.length && !cfg.dryRun) await this.d.kv.set(FREE_KEY, current);
      return { action: "skipped", why: "no_new_models" };
    }
    const st = await this.d.kv.get<{ issueId: string; companyId: string }>(BENCH_KEY);
    if (st?.issueId) {
      const open = await this.d.getIssue(st.issueId, st.companyId);
      if (open && !TERMINAL.has(open.status)) {
        this.d.log("opencode_watchdog.new_model_benchmark_open", { issueId: st.issueId, added });
        return { action: "skipped", why: "benchmark_open" };
      }
    }
    const agents = await this.d.listAgents(companyId);
    let assignee = cfg.benchmarkAgentId;
    if (!assignee) assignee = agents.find((a) => a.name.toLowerCase() === cfg.benchmarkAgentName.toLowerCase())?.id ?? null;
    if (!assignee) return this.skip("no_benchmark_agent", { added });
    const hash = createHash("sha256").update(added.join(",")).digest("hex").slice(0, 12);
    const originId = `${ORIGIN_PREFIX}newmodel:${hash}`;
    const title = `Re-benchmark free OpenCode models: new free model(s) ${added.join(", ")}`;
    if (cfg.dryRun) {
      this.d.log("opencode_watchdog.dry_run", { what: "new_model_issue", title });
      return { action: "dry_run", reason: "new_model" };
    }
    const description = [
      `The OpenCode Zen free list gained: ${added.map((m) => `\`${m}\``).join(", ")}.`,
      "",
      `Snapshot time: ${snap.fetchedAt}`,
      "",
      "## Full current free list",
      ...current.map((m) => `- \`opencode/${m}\``),
      "",
      "## What to do",
      "Re-run the free-model benchmark including the new model(s). Task set: `/home/paperclip/work/pla-10371/bench/`.",
      ...(removed.length ? ["", `Removed since last baseline (info only): ${removed.map((m) => `\`${m}\``).join(", ")}`] : []),
      "",
      `Dedupe key: \`${originId}\``,
    ].join("\n");
    const created = await this.d.createIssue({ companyId, title, description, priority: "medium", status: "todo", assigneeAgentId: assignee, ...(cfg.benchmarkParentIssueId ? { parentId: cfg.benchmarkParentIssueId } : {}), originKind: ORIGIN_KIND, originId });
    await this.d.kv.set(BENCH_KEY, { issueId: created.id, companyId });
    await this.d.kv.set(FREE_KEY, current);
    this.d.log("opencode_watchdog.new_model_issue_created", { issueId: created.id, added });
    this.d.metric("opencode_watchdog.new_model_issue_created");
    return { action: "created", issueId: created.id, reason: "new_model" };
  }

  private async rescue(agent: AgentView, info: { reason: string; runId: string | null; error: string; matched: string | null; failedIssueId?: string | null }, known?: ModelSnapshot): Promise<Outcome> {
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
      const rescuerInfo = await this.resolveRescuer(agent.companyId);
      const rescuer = rescuerInfo?.id ?? null;
      if (!rescuer || !rescuerInfo) return this.skip("no_rescue_agent", { agentId: agent.id });
      if (rescuer === agent.id) return this.skip("rescue_agent_is_failing_agent", { agentId: agent.id });
      const snap = known ?? (await this.d.snapshot());
      const model = typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : null;
      const bucket = hourBucket(now, cfg.debounceHours);
      const originId = `${ORIGIN_PREFIX}${agent.id}:${bucket}`;
      const description = renderBody({ agent, model, info, snap, rescuer, rescuerName: rescuerInfo.name, snapshotPath: snapshotPathIfExists(cfg.snapshotDir, agent.id), originId });
      const title = `Rescue: opencode model unavailable for ${agent.name} (${model ?? "no model set"})`;
      if (cfg.dryRun) {
        this.d.log("opencode_watchdog.dry_run", { agentId: agent.id, reason: info.reason, title });
        return { action: "dry_run", reason: info.reason };
      }
      const created = await this.d.createIssue({ companyId: agent.companyId, title, description, priority: "high", status: "todo", assigneeAgentId: rescuer, originKind: ORIGIN_KIND, originId });
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

  private async resolveRescuer(companyId: string): Promise<{ id: string; name: string } | null> {
    const cfg = this.d.cfg();
    const agents = await this.d.listAgents(companyId);
    if (cfg.rescueAgentId) {
      const hit = agents.find((a) => a.id === cfg.rescueAgentId);
      return { id: cfg.rescueAgentId, name: hit?.name ?? cfg.rescueAgentName };
    }
    const want = cfg.rescueAgentName.toLowerCase();
    const hit = agents.find((a) => a.name.toLowerCase() === want);
    return hit ? { id: hit.id, name: hit.name } : null;
  }
}

function snapshotPathIfExists(dir: string | null | undefined, agentId: string): string | null {
  if (!dir) return null;
  const path = `${dir.replace(/\/+$/, "")}/${agentId}.json`;
  try { return existsSync(path) ? path : null; } catch { return null; }
}

export function renderBody(i: {
  agent: AgentView; model: string | null; rescuer: string; rescuerName: string; snapshotPath: string | null; originId: string;
  info: { reason: string; runId: string | null; error: string; matched: string | null; failedIssueId?: string | null }; snap: ModelSnapshot | null;
}): string {
  const meta = { agentId: i.agent.id, agentName: i.agent.name, previousModel: i.model, runId: i.info.runId, failedIssueId: i.info.failedIssueId ?? null, reason: i.info.reason, rescueKey: i.originId };
  const free = i.snap ? i.snap.free.map((m) => `- \`opencode/${m}\``).join("\n") : "_Zen model list unavailable at event time. Fetch it yourself (see step 1)._";
  const health = i.snap ? classifyModel(i.model, i.snap) : null;
  const inList = !i.snap ? "UNKNOWN (list unavailable; fetch it in step 1)" : health === "ok" ? "YES" : "NO";
  const action = inList === "NO";
  return [
    ...(action ? ["# ACTION REQUIRED", ""] : []),
    `Automatic rescue request from the opencode free-model watchdog. Reason: **${i.info.reason}**.`,
    "",
    "## READ THIS FIRST",
    "- (a) `GET /api/agents/<id>` shows an EMPTY `adapterConfig` to agents. This is expected (config is redacted). It is NOT evidence that the model is fine or gone.",
    "- (b) The Facts section and the Zen list below are the source of truth (current model, error, Zen list snapshot).",
    "- (c) Decide from the Zen list: if the current model id is not in the list, or is no longer free, this is a real failure and you MUST `PATCH`.",
    "- (d) The `PATCH` sends ONLY `{\"adapterConfig\":{\"model\":\"opencode/<id>\"}}`. The server merges it. Agents may only change `model` / `fallbackModel` on another agent. Check the result by the `PATCH` response status and the next run, not by reading `adapterConfig`.",
    "- (e) You may close this rescue without a `PATCH` only if the current model IS in the Zen free list.",
    "",
    "## Facts",
    `- Agent: ${i.agent.name} (\`${i.agent.id}\`), adapter \`opencode_local\``,
    `- Current model: \`${i.model ?? "(none)"}\``,
    `- Current model in Zen free list: ${inList}`,
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
    `## Rescue instructions (${i.rescuerName}, Sonnet; never Opus)`,
    "1. If the list above is missing, read it: `GET https://opencode.ai/zen/v1/models`. Free = id ends in `-free`, or `big-pickle`, or cost 0 in https://models.dev/api.json (provider `opencode`).",
    "2. Pick the best currently-free model: same family and size as the current one if possible, tool-use capable.",
    "3. `PATCH /api/agents/<agentId>` with ONLY `{\"adapterConfig\":{\"model\":\"opencode/<id>\"}}`. Do not send the rest of adapterConfig. Touch only the affected agent.",
    ...(i.info.failedIssueId
      ? [`3b. **Re-queue the failed task.** The run that failed belonged to issue \`${i.info.failedIssueId}\` and it may now be stuck. Right after the model \`PATCH\` succeeds (2xx): read it with \`GET /api/issues/${i.info.failedIssueId}\`. If its status is \`blocked\` or \`in_progress\` and it is still assigned to this agent, send \`PATCH /api/issues/${i.info.failedIssueId}\` with \`{"status":"todo","comment":"Model replaced by the watchdog rescue; re-queued."}\`. This wakes the assignee. Skip it if the status is \`done\` or \`cancelled\`. Do not do it when you made no model change.`]
      : []),
    "4. If no free model fits, do NOT run `restore-agent.mjs`: it needs a board key (for `adapterType`) and an agent token can only change the model. Comment on this rescue issue and assign the CTO.",
    i.snapshotPath ? `5. Pre-migration snapshot: \`${i.snapshotPath}\` (for the CTO or a board key holder).` : "5. No snapshot (agent was never migrated); fallback = set a free model, else tell the CTO.",
    "6. The previous model is recorded by the plugin (`previousModel` in the JSON below). To roll back (board key): `node scripts/restore-model.mjs --agent <agentId> --state-file <state.json> --apply`.",
    `7. Post an operator comment that starts with \`[[operator-deliver]]\` and ends with the footer \`— ${i.rescuerName} · <ISSUE-KEY>\`.`,
    "",
    "<details><summary>machine-readable</summary>",
    "",
    "```json",
    JSON.stringify(meta, null, 2),
    "```",
    "</details>",
  ].join("\n");
}
