import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { parseConfig } from "../src/config.js";
import { fetchModelSnapshot, classifyModel, type Fetcher } from "../src/zen.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("manifest", () => {
  it("versions move together", () => expect(manifest.version).toBe(pkg.version));
  it("capability set is pinned; only write is issues.create; no agent-mutating capability", () => {
    expect([...manifest.capabilities].sort()).toEqual(["agents.read", "api.routes.register", "companies.read", "events.subscribe", "http.outbound", "issues.create", "issues.read", "jobs.schedule", "metrics.write", "plugin.state.read", "plugin.state.write"]);
    for (const c of manifest.capabilities) expect(PLUGIN_CAPABILITIES as readonly string[]).toContain(c);
    expect(manifest.capabilities.filter((c) => /pause|resume|invoke|managed|write$/.test(c) && !["plugin.state.write","metrics.write"].includes(c))).toEqual([]);
  });
});

describe("config", () => {
  it("garbage -> safe defaults (proactive off, dry run off)", () => {
    const c = parseConfig({ proactiveEnabled: "yes", debounceHours: -1, zenModelsUrl: "http://evil", agentAllowlist: ["nope"] });
    expect(c).toMatchObject({ proactiveEnabled: false, debounceHours: 1, agentAllowlist: [], agentDenylist: [], zenModelsUrl: "https://opencode.ai/zen/v1/models" });
  });
  it("agentDenylist keeps uuids, drops junk, defaults to []", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseConfig({}).agentDenylist).toEqual([]);
    expect(parseConfig({ agentDenylist: [id, "nope", 5] }).agentDenylist).toEqual([id]);
  });
});

describe("zen snapshot", () => {
  const res = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
  it("classifies free by suffix, big-pickle and catalog cost 0", async () => {
    const f: Fetcher = async (u) => u.includes("zen") ? res({ data: [{ id: "a-free" }, { id: "big-pickle" }, { id: "paid" }, { id: "zero" }] }) : res({ opencode: { models: { zero: { cost: { input: 0, output: 0 } }, paid: { cost: { input: 1, output: 2 } } } } });
    const s = await fetchModelSnapshot(f, { zenUrl: "https://x/zen", catalogUrl: "https://x/cat", now: () => 0 });
    expect(s!.free).toEqual(["a-free", "big-pickle", "zero"]);
    expect(classifyModel("opencode/paid", s!)).toBe("no_longer_free");
    expect(classifyModel("opencode/gone", s!)).toBe("removed");
    expect(classifyModel("anthropic/x", s!)).toBe("out_of_scope");
  });
  it("HTTP failure or empty list -> null", async () => {
    expect(await fetchModelSnapshot(async () => res({}, false), { zenUrl: "https://x", catalogUrl: null, now: () => 0 })).toBeNull();
    expect(await fetchModelSnapshot(async () => res({ data: [] }), { zenUrl: "https://x", catalogUrl: null, now: () => 0 })).toBeNull();
  });
});

describe("worker wiring in the SDK harness", () => {
  it("agent.run.failed on a non-opencode agent makes no issue and no output beyond a skip log", async () => {
    const h = createTestHarness({ manifest, config: {} });
    h.seed({ companies: [{ id: "c", name: "c" }] as any, agents: [{ id: "a1", companyId: "c", name: "A", adapterType: "claude_local", adapterConfig: {} }] as any });
    await plugin.definition.setup(h.ctx);
    await h.emit("agent.run.failed", { runId: "r", agentId: "a1", error: "ProviderModelNotFoundError" }, { companyId: "c" });
    expect(h.logs.some((l: any) => l.message === "opencode_watchdog.rescue_created")).toBe(false);
    expect(h.logs.some((l: any) => l.message === "opencode_watchdog.skipped")).toBe(true);
  });
  it("opencode agent + model error -> rescue issue created end to end", async () => {
    const h = createTestHarness({ manifest, config: { rescueAgentId: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1", modelsDevUrl: null } });
    h.seed({ companies: [{ id: "c", name: "c" }] as any, agents: [{ id: "a1", companyId: "c", name: "OpenCodeTest", adapterType: "opencode_local", adapterConfig: { model: "opencode/x-free" } }] as any });
    await plugin.definition.setup(h.ctx);
    await h.emit("agent.run.failed", { runId: "r", agentId: "a1", error: "ProviderModelNotFoundError" }, { companyId: "c" });
    expect(h.logs.some((l: any) => l.message === "opencode_watchdog.rescue_created")).toBe(true);
  });
});
