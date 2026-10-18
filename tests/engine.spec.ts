import { describe, expect, it } from "vitest";
import { agent, CO, CTO, failed, mk, OC, SNAP } from "./fake.js";
import fixtures from "./fixtures/errors.json" with { type: "json" };
import { compilePatterns, matchModelError, sanitizeError, DEFAULT_ERROR_PATTERNS } from "../src/detect.js";

describe("AC1 event path", () => {
  it("matching failure -> exactly one rescue issue, high priority, assigned to CTO", async () => {
    const t = mk();
    const out = await t.engine.onRunFailed(failed());
    expect(out.action).toBe("created");
    expect(t.writes).toHaveLength(1);
    const w = t.writes[0] as Record<string, string>;
    expect(w.assigneeAgentId).toBe(CTO);
    expect(w.priority).toBe("high");
    expect(w.originId).toMatch(/^opencode-watchdog:/);
    expect(w.description).toContain("run-1");
    expect(w.description).toContain("opencode/glm-5.3-flash-free");
    expect(w.description).toContain("[[operator-deliver]]");
    expect(w.description).toContain("`opencode/big-pickle`");
    expect((await t.engine.states())[OC]).toMatchObject({ previousModel: "opencode/glm-5.3-flash-free", companyId: CO });
  });
  it("non-opencode agent failure -> none", async () => {
    const t = mk({ agents: [agent(OC, { adapterType: "claude_local" }), agent(CTO)] });
    expect(await t.engine.onRunFailed(failed())).toMatchObject({ action: "skipped", why: "not_opencode" });
    expect(t.writes).toHaveLength(0);
  });
  it("non-model error on opencode agent -> none", async () => {
    const t = mk();
    for (const f of fixtures.negative) expect(await t.engine.onRunFailed(failed({ error: f.error, errorCode: f.errorCode }))).toMatchObject({ why: "not_model_error" });
    expect(t.writes).toHaveLength(0);
  });
  it("second failure within 1h -> none; after the window, one more", async () => {
    const t = mk();
    await t.engine.onRunFailed(failed());
    t.issues["iss-1"].status = "done"; // closed rescue: debounce alone must hold
    expect(await t.engine.onRunFailed(failed({ runId: "run-2" }))).toMatchObject({ why: "debounced" });
    t.clock.t += 61 * 60_000;
    expect((await t.engine.onRunFailed(failed({ runId: "run-3" }))).action).toBe("created");
    expect(t.writes).toHaveLength(2);
  });
  it("open rescue issue for the same agent drops later failures even after the window", async () => {
    const t = mk();
    await t.engine.onRunFailed(failed());
    t.clock.t += 5 * 3_600_000;
    expect(await t.engine.onRunFailed(failed({ runId: "run-2" }))).toMatchObject({ why: "rescue_open" });
    expect(t.writes).toHaveLength(1);
  });
  it("rescue-run failure -> none (run belongs to a rescue issue)", async () => {
    const t = mk({ issues: { "resc-1": { status: "in_progress", originId: "opencode-watchdog:x:1" } } });
    expect(await t.engine.onRunFailed(failed({ issueId: "resc-1" }))).toMatchObject({ why: "rescue_issue_run" });
    expect(t.writes).toHaveLength(0);
  });
  it("rescue agent's own failure -> none, even when it is opencode_local", async () => {
    const t = mk({ cfg: { rescueAgentId: OC } });
    expect(await t.engine.onRunFailed(failed())).toMatchObject({ why: "rescue_agent_run" });
  });
  it("concurrent events for one agent create exactly one issue", async () => {
    const t = mk();
    await Promise.all([t.engine.onRunFailed(failed()), t.engine.onRunFailed(failed({ runId: "r2" })), t.engine.onRunFailed(failed({ runId: "r3" }))]);
    expect(t.writes).toHaveLength(1);
  });
  it("allowlist: unlisted agents are never touched", async () => {
    const other = "11111111-1111-4111-8111-111111111111";
    const t = mk({ agents: [agent(OC), agent(other), agent(CTO)], cfg: { agentAllowlist: [OC] } });
    expect(await t.engine.onRunFailed(failed({ agentId: other }))).toMatchObject({ why: "not_allowlisted" });
    expect(t.writes).toHaveLength(0);
  });
  it("dry run writes nothing", async () => {
    const t = mk({ cfg: { dryRun: true } });
    expect((await t.engine.onRunFailed(failed())).action).toBe("dry_run");
    expect(t.writes).toHaveLength(0);
  });
  it("still raises the rescue when the Zen list is unavailable", async () => {
    const t = mk({ snap: null });
    expect((await t.engine.onRunFailed(failed())).action).toBe("created");
    expect((t.writes[0] as Record<string, string>).description).toContain("Zen model list unavailable");
  });
});

describe("matcher + fixtures", () => {
  const re = compilePatterns(DEFAULT_ERROR_PATTERNS);
  it("every positive fixture matches, every negative does not", () => {
    for (const f of fixtures.positive) expect(matchModelError(`${f.errorCode ?? ""}\n${f.error}`, re), f.error).not.toBeNull();
    for (const f of fixtures.negative) expect(matchModelError(`${f.errorCode ?? ""}\n${f.error}`, re), f.error).toBeNull();
  });
  it("invalid user regex is ignored, not thrown", () => {
    expect(compilePatterns(["(", "ok"])).toHaveLength(1);
  });
  it("sanitize redacts credentials and truncates", () => {
    const s = sanitizeError("Authorization: Bearer abcdef1234567890 api_key=supersecret99 " + "x".repeat(2000), 100);
    expect(s).not.toContain("abcdef1234567890");
    expect(s).not.toContain("supersecret99");
    expect(s.length).toBeLessThan(130);
  });
});

describe("AC2 healthy = zero writes, zero reads, no output", () => {
  it("no event -> nothing happens; proactive flag off -> returns before any read", async () => {
    const t = mk();
    expect(await t.engine.proactive([CO])).toEqual([]);
    expect(t.writes).toHaveLength(0);
    expect(t.reads.snapshot).toBe(0);
    expect(t.logs).toHaveLength(0);
  });
});

describe("AC4/AC5 proactive check", () => {
  it("healthy: configured free model present -> zero writes, one list read", async () => {
    const t = mk({ cfg: { proactiveEnabled: true } });
    expect(await t.engine.proactive([CO])).toEqual([]);
    expect(t.writes).toHaveLength(0);
    expect(t.reads.snapshot).toBe(1);
    expect(t.logs.map((l) => l.msg)).toEqual(["opencode_watchdog.proactive_healthy"]);
  });
  it("simulated removal -> rescue for OpenCodeTest only", async () => {
    const other = "11111111-1111-4111-8111-111111111111";
    const gone = { all: ["big-pickle"], free: ["big-pickle"], fetchedAt: SNAP.fetchedAt };
    const t = mk({ agents: [agent(OC), agent(other, { adapterConfig: { model: "anthropic/x" } }), agent("22222222-2222-4222-8222-222222222222", { adapterType: "claude_local" }), agent(CTO, { adapterType: "claude_local", adapterConfig: {} })], cfg: { proactiveEnabled: true, agentAllowlist: [OC] }, snap: gone });
    const out = await t.engine.proactive([CO]);
    expect(out).toEqual([{ action: "created", issueId: "iss-1", reason: "proactive_removed" }]);
    expect(JSON.stringify(t.writes[0])).toContain(OC);
    expect(t.writes).toHaveLength(1);
  });
  it("model still served but no longer free -> rescue", async () => {
    const t = mk({ cfg: { proactiveEnabled: true }, snap: { all: SNAP.all, free: ["big-pickle"], fetchedAt: SNAP.fetchedAt } });
    expect((await t.engine.proactive([CO]))[0]).toMatchObject({ reason: "proactive_no_longer_free" });
  });
  it("list fetch failure -> no action", async () => {
    const t = mk({ cfg: { proactiveEnabled: true }, snap: null });
    expect(await t.engine.proactive([CO])).toEqual([]);
    expect(t.writes).toHaveLength(0);
  });
  it("re-run converges: second run the same hour makes no second issue", async () => {
    const t = mk({ cfg: { proactiveEnabled: true }, snap: { all: ["big-pickle"], free: ["big-pickle"], fetchedAt: SNAP.fetchedAt } });
    await t.engine.proactive([CO]); await t.engine.proactive([CO]);
    expect(t.writes).toHaveLength(1);
  });
});

describe("0.1.1 timeout + UnknownError", () => {
  it("timeout on opencode agent -> one timeout_suspect rescue with check-first note; debounced after", async () => {
    const t = mk();
    const ev = failed({ errorCode: "timeout", error: "Timed out after 45s" });
    expect(await t.engine.onRunFailed(ev)).toMatchObject({ action: "created", reason: "timeout_suspect" });
    expect(t.writes).toHaveLength(1);
    expect((t.writes[0] as Record<string, string>).description).toContain("close this issue with no change");
    expect(await t.engine.onRunFailed(ev)).toMatchObject({ why: "debounced" });
    expect(t.writes).toHaveLength(1);
  });
  it("timeout on non-opencode agent -> none", async () => {
    const t = mk({ agents: [agent(OC, { adapterType: "claude_local" }), agent(CTO)] });
    expect(await t.engine.onRunFailed(failed({ errorCode: "timeout", error: "Timed out after 45s" }))).toMatchObject({ why: "not_opencode" });
    expect(t.writes).toHaveLength(0);
  });
  it("observed UnknownError string matches default patterns", () => {
    const re = compilePatterns(DEFAULT_ERROR_PATTERNS);
    for (const f of fixtures.observed) expect(matchModelError(`${f.errorCode ?? ""}\n${f.error}`, re)).not.toBeNull();
    expect(fixtures.observed.length).toBeGreaterThan(0);
  });
});
