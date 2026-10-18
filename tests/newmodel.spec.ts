import { describe, expect, it } from "vitest";
import { CO, CTO, mk, SNAP, agent } from "./fake.js";

const BASE = ["big-pickle", "glm-5.3-flash-free"];
const NEW = { ...SNAP, free: [...SNAP.free, "new-model-free"], all: [...SNAP.all, "new-model-free"] };
const on = { newModelWatchEnabled: true, benchmarkAgentName: "CTO" };
const agents = [agent(CTO, { name: "CTO", adapterType: "claude_local", adapterConfig: {} })];

describe("0.3.0 new free model watch", () => {
  it("first run seeds baseline, no issue", async () => {
    const t = mk({ agents, cfg: on });
    const o = await t.engine.newModels(CO);
    expect(o).toEqual({ action: "skipped", why: "baseline_seeded" });
    expect(t.writes).toHaveLength(0);
    expect(await t.kv.get("freeModels")).toEqual(BASE);
    expect(t.logs.some((l) => l.msg === "opencode_watchdog.new_model_baseline_seeded")).toBe(true);
  });
  it("new id raises exactly one medium issue and updates baseline", async () => {
    const t = mk({ agents, cfg: on, snap: NEW });
    await t.kv.set("freeModels", BASE);
    const o = await t.engine.newModels(CO);
    expect(o.action).toBe("created");
    expect(t.writes).toHaveLength(1);
    const w = t.writes[0] as Record<string, string>;
    expect(w.title).toBe("Re-benchmark free OpenCode models: new free model(s) new-model-free");
    expect(w.priority).toBe("medium");
    expect(w.assigneeAgentId).toBe(CTO);
    expect(w.originKind).toBe("plugin:platform.opencode-watchdog");
    expect(w.originId).toMatch(/^opencode-watchdog:newmodel:[0-9a-f]{12}$/);
    expect(w.description).toContain("/home/paperclip/work/pla-10371/bench/");
    expect(w.description).toContain(NEW.fetchedAt);
    expect(await t.kv.get("freeModels")).toEqual([...BASE, "new-model-free"]);
  });
  it("parent id is passed when configured", async () => {
    const pid = "d0000000-0000-4000-8000-000000000009";
    const t = mk({ agents, cfg: { ...on, benchmarkParentIssueId: pid }, snap: NEW });
    await t.kv.set("freeModels", BASE);
    await t.engine.newModels(CO);
    expect((t.writes[0] as Record<string, string>).parentId).toBe(pid);
  });
  it("no change = zero writes", async () => {
    const t = mk({ agents, cfg: on });
    await t.kv.set("freeModels", BASE);
    expect(await t.engine.newModels(CO)).toEqual({ action: "skipped", why: "no_new_models" });
    expect(t.writes).toHaveLength(0);
  });
  it("second new model while previous issue open = no duplicate", async () => {
    const t = mk({ agents, cfg: on, snap: NEW });
    await t.kv.set("freeModels", BASE);
    await t.engine.newModels(CO);
    const more = { ...NEW, free: [...NEW.free, "z-free"], all: [...NEW.all, "z-free"] };
    const t2 = { ...t };
    (t2 as any).engine = t.engine;
    // swap snapshot by new engine sharing kv/issues is not possible; reset baseline to force a diff
    await t.kv.set("freeModels", BASE);
    expect((await t.engine.newModels(CO)).action).toBe("skipped");
    expect(t.writes).toHaveLength(1);
    void more;
  });
  it("fetch failure = no-op, baseline untouched", async () => {
    const t = mk({ agents, cfg: on, snap: null });
    await t.kv.set("freeModels", BASE);
    expect(await t.engine.newModels(CO)).toEqual({ action: "skipped", why: "list_unavailable" });
    expect(t.writes).toHaveLength(0);
    expect(await t.kv.get("freeModels")).toEqual(BASE);
  });
  it("dryRun writes nothing, baseline unchanged", async () => {
    const t = mk({ agents, cfg: { ...on, dryRun: true }, snap: NEW });
    await t.kv.set("freeModels", BASE);
    expect((await t.engine.newModels(CO)).action).toBe("dry_run");
    expect(t.writes).toHaveLength(0);
    expect(await t.kv.get("freeModels")).toEqual(BASE);
    const s = mk({ agents, cfg: { ...on, dryRun: true } });
    await s.engine.newModels(CO);
    expect(await s.kv.get("freeModels")).toBeUndefined();
  });
  it("flag off = silent", async () => {
    const t = mk({ agents });
    expect(await t.engine.newModels(CO)).toEqual({ action: "skipped", why: "disabled" });
    expect(t.reads.snapshot).toBe(0);
    expect(t.writes).toHaveLength(0);
  });
  it("closed previous issue allows a new one", async () => {
    const t = mk({ agents, cfg: on, snap: NEW });
    await t.kv.set("freeModels", BASE);
    await t.engine.newModels(CO);
    t.issues["iss-1"].status = "done";
    await t.kv.set("freeModels", BASE);
    expect((await t.engine.newModels(CO)).action).toBe("created");
  });
});
