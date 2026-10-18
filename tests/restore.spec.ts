import { createServer } from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("../scripts/restore-model.mjs", import.meta.url).pathname;
const ID = "9d487375-7a73-429a-b31b-7a601ae49385";

async function withServer(model: string, fn: (url: string, patches: unknown[]) => Promise<void>) {
  let cfg: Record<string, unknown> = { model, extra: 1 };
  const patches: unknown[] = [];
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (req.method === "PATCH") { const j = JSON.parse(b); patches.push(j); cfg = j.adapterConfig; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: ID, adapterType: "opencode_local", adapterConfig: cfg }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${(srv.address() as { port: number }).port}`, patches); } finally { srv.close(); }
}
const run = (url: string, extra: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
  import("node:child_process").then(({ execFile }) => execFile("node", [script, "--agent", ID, ...extra], { env: { ...process.env, PAPERCLIP_API_URL: url, PAPERCLIP_API_KEY: "test-not-secret" } }, (e, out) => resolve({ code: e ? (e as { code?: number }).code ?? 1 : 0, out })));
});

describe("restore-model", () => {
  const f = join(mkdtempSync(join(tmpdir(), "rm-")), "state.json");
  writeFileSync(f, JSON.stringify({ agents: { [ID]: { previousModel: "opencode/glm-5.3-flash-free" } } }));
  it("dry run writes nothing; apply changes only model; re-run is a no-op", async () => {
    await withServer("claude-sonnet-5-5", async (url, patches) => {
      expect((await run(url, ["--state-file", f])).out).toContain("dry_run");
      expect(patches).toHaveLength(0);
      const a = await run(url, ["--state-file", f, "--apply"]);
      expect(a.code).toBe(0);
      expect(patches).toEqual([{ adapterConfig: { model: "opencode/glm-5.3-flash-free", extra: 1 } }]);
      expect((await run(url, ["--state-file", f, "--apply"])).out).toContain("already_restored");
      expect(patches).toHaveLength(1);
    });
  });
});

describe("restore-agent", () => {
  const sc = new URL("../scripts/restore-agent.mjs", import.meta.url).pathname;
  const f = join(mkdtempSync(join(tmpdir(), "ra-")), "snap.json");
  writeFileSync(f, JSON.stringify({ agentId: ID, adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-5-5", secretish: "TOPSECRETVALUE" } }));
  const go = (url: string, extra: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
    import("node:child_process").then(({ execFile }) => execFile("node", [sc, "--agent", ID, "--snapshot-file", f, ...extra], { env: { ...process.env, PAPERCLIP_API_URL: url, PAPERCLIP_API_KEY: "test-not-secret" } }, (e, out) => resolve({ code: e ? (e as { code?: number }).code ?? 1 : 0, out })));
  });
  it("dry run writes nothing; apply restores type+config; re-run is no-op; no values printed", async () => {
    let cfg: Record<string, unknown> = { model: "opencode/x" }, type = "prime_local";
    const patches: unknown[] = [];
    const srv = createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => {
        if (req.method === "PATCH") { const j = JSON.parse(b); patches.push(j); cfg = j.adapterConfig; type = j.adapterType; }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: ID, adapterType: type, adapterConfig: cfg }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const d = await go(url, []);
      expect(d.out).toContain("dry_run"); expect(d.out).toContain("secretish"); expect(patches).toHaveLength(0);
      const a = await go(url, ["--apply"]);
      expect(a.code).toBe(0); expect(patches).toHaveLength(1);
      expect(d.out + a.out).not.toContain("TOPSECRETVALUE"); expect(d.out + a.out).not.toContain("claude-sonnet-5-5");
      expect((await go(url, ["--apply"])).out).toContain("already_restored");
      expect(patches).toHaveLength(1);
    } finally { srv.close(); }
  });
});
