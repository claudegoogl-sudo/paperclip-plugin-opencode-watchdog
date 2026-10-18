#!/usr/bin/env node
// restore-agent: put an agent's adapterType + adapterConfig back from a pre-migration snapshot.
// Dry run by default. Idempotent: if the agent already matches the snapshot, it writes nothing.
//   node scripts/restore-agent.mjs --agent <uuid> --snapshot-file snap.json [--apply]
// snap.json = { "agentId": "...", "adapterType": "...", "adapterConfig": { ... } }
// Auth: PAPERCLIP_API_URL + PAPERCLIP_API_KEY (+ PAPERCLIP_RUN_ID for writes) from the environment. Never printed.
// Output lists config KEY NAMES only, never values.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? null : args[i + 1] ?? true; };
const agentId = flag("agent");
const file = flag("snapshot-file");
const apply = args.includes("--apply");
if (typeof agentId !== "string" || typeof file !== "string") { console.error("usage: restore-agent --agent <id> --snapshot-file <file> [--apply]"); process.exit(2); }
let snap;
try { snap = JSON.parse(readFileSync(file, "utf8")); } catch { console.error("cannot read snapshot file"); process.exit(3); }
if (snap?.agentId !== agentId || typeof snap.adapterType !== "string" || !snap.adapterConfig || typeof snap.adapterConfig !== "object") { console.error("snapshot invalid or for another agent"); process.exit(3); }
const base = process.env.PAPERCLIP_API_URL, key = process.env.PAPERCLIP_API_KEY;
if (!base || !key) { console.error("PAPERCLIP_API_URL and PAPERCLIP_API_KEY must be set"); process.exit(2); }
const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(process.env.PAPERCLIP_RUN_ID ? { "X-Paperclip-Run-Id": process.env.PAPERCLIP_RUN_ID } : {}) };
const get = async () => { const r = await fetch(`${base}/agents/${agentId}`, { headers }); if (!r.ok) throw new Error(`GET agent -> ${r.status}`); return r.json(); };
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const diffKeys = (a = {}, b = {}) => Object.keys({ ...a, ...b }).filter((k) => canon(a[k]) !== canon(b[k])).sort();

const before = await get();
const typeDiff = before.adapterType !== snap.adapterType;
const keys = diffKeys(before.adapterConfig, snap.adapterConfig);
if (!typeDiff && keys.length === 0) { console.log(JSON.stringify({ agentId, status: "already_restored", adapterType: snap.adapterType })); process.exit(0); }
console.log(JSON.stringify({ agentId, mode: apply ? "apply" : "dry_run", adapterType: { from: before.adapterType, to: snap.adapterType }, changedConfigKeys: keys }));
if (!apply) process.exit(0);
const r = await fetch(`${base}/agents/${agentId}`, { method: "PATCH", headers, body: JSON.stringify({ adapterType: snap.adapterType, adapterConfig: snap.adapterConfig }) });
if (!r.ok) { console.error(`PATCH -> ${r.status}`); process.exit(1); }
const after = await get();
const ok = after.adapterType === snap.adapterType && diffKeys(after.adapterConfig, snap.adapterConfig).length === 0;
console.log(JSON.stringify({ agentId, status: ok ? "restored" : "mismatch_after_patch", adapterType: after.adapterType }));
process.exit(ok ? 0 : 1);
