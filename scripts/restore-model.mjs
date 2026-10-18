#!/usr/bin/env node
// restore-model: put an agent's adapterConfig.model back to the value the watchdog recorded.
// Dry run by default. Idempotent: if the model already equals the target, it exits 0 and writes nothing.
//   node scripts/restore-model.mjs --agent <uuid> --state-file state.json [--apply]
//   node scripts/restore-model.mjs --agent <uuid> --model opencode/glm-5.3-flash-free [--apply]
// state.json = the body of GET /api/plugins/platform.opencode-watchdog/api/state ({ "agents": { "<id>": { "previousModel": ... } } }).
// Auth: PAPERCLIP_API_URL + PAPERCLIP_API_KEY (+ PAPERCLIP_RUN_ID for writes) from the environment. Never printed.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? null : args[i + 1] ?? true; };
const agentId = flag("agent");
const apply = args.includes("--apply");
if (!agentId || typeof agentId !== "string") { console.error("usage: restore-model --agent <id> (--state-file f | --model m) [--apply]"); process.exit(2); }

let target = typeof flag("model") === "string" ? flag("model") : null;
if (!target) {
  const f = flag("state-file");
  if (typeof f !== "string") { console.error("need --state-file or --model"); process.exit(2); }
  const st = JSON.parse(readFileSync(f, "utf8"));
  target = st?.agents?.[agentId]?.previousModel ?? st?.[agentId]?.previousModel ?? null;
  if (!target) { console.error(`no previousModel recorded for ${agentId}`); process.exit(3); }
}
const base = process.env.PAPERCLIP_API_URL, key = process.env.PAPERCLIP_API_KEY;
if (!base || !key) { console.error("PAPERCLIP_API_URL and PAPERCLIP_API_KEY must be set"); process.exit(2); }
const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(process.env.PAPERCLIP_RUN_ID ? { "X-Paperclip-Run-Id": process.env.PAPERCLIP_RUN_ID } : {}) };
const get = async () => { const r = await fetch(`${base}/agents/${agentId}`, { headers }); if (!r.ok) throw new Error(`GET agent -> ${r.status}`); return r.json(); };

const before = await get();
const cfg = before.adapterConfig ?? {};
if (cfg.model === target) { console.log(JSON.stringify({ agentId, status: "already_restored", model: target })); process.exit(0); }
console.log(JSON.stringify({ agentId, adapterType: before.adapterType, from: cfg.model ?? null, to: target, mode: apply ? "apply" : "dry_run" }));
if (!apply) process.exit(0);
const r = await fetch(`${base}/agents/${agentId}`, { method: "PATCH", headers, body: JSON.stringify({ adapterConfig: { ...cfg, model: target } }) });
if (!r.ok) { console.error(`PATCH -> ${r.status}`); process.exit(1); }
const after = await get();
const changed = Object.keys({ ...before.adapterConfig, ...after.adapterConfig }).filter((k) => JSON.stringify(before.adapterConfig?.[k]) !== JSON.stringify(after.adapterConfig?.[k]));
console.log(JSON.stringify({ agentId, status: "restored", readBackModel: after.adapterConfig?.model, changedKeys: changed }));
process.exit(after.adapterConfig?.model === target && changed.length === 1 ? 0 : 1);
