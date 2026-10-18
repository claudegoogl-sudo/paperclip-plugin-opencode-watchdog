import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { CONFIG_SCHEMA } from "./config.js";

export const VERSION = "0.1.0";

/**
 * Capability set. Pinned by tests/manifest.spec.ts; changing it needs SecurityEngineer review.
 * - events.subscribe: `agent.run.failed` is the trigger. No timer polls when healthy.
 * - issues.create: the ONLY write. One rescue issue, assigned to the rescue agent (assignment wakes it).
 * - http.outbound: read-only GET of the public Zen model list (+ optional public catalog). No auth, no LLM.
 * - agents.read / issues.read: resolve adapter type + model, check rescue issue state.
 * No agents.configure-type capability exists for plugins: the plugin never edits any agent.
 */
export const CAPABILITIES = [
  "events.subscribe",
  "jobs.schedule",
  "plugin.state.read",
  "plugin.state.write",
  "companies.read",
  "agents.read",
  "issues.read",
  "issues.create",
  "http.outbound",
  "metrics.write",
  "api.routes.register",
] as const;

export const JOBS = { modelCheck: "model-check" } as const;

const manifest: PaperclipPluginManifestV1 = {
  id: "platform.opencode-watchdog",
  apiVersion: 1,
  version: VERSION,
  displayName: "OpenCode free-model watchdog",
  description: "Event-driven: when an opencode_local agent's run fails because its model is gone or no longer free, opens one rescue issue for the CTO. Healthy = zero writes.",
  author: "Platform <platform@paperclip.ing>",
  categories: ["automation"],
  capabilities: [...CAPABILITIES],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: CONFIG_SCHEMA as unknown as PaperclipPluginManifestV1["instanceConfigSchema"],
  jobs: [{ jobKey: JOBS.modelCheck, displayName: "Daily model-list check (flag-gated, silent when healthy)", schedule: "23 6 * * *" }],
  apiRoutes: [{ routeKey: "state", method: "GET", path: "/state", auth: "agent", capability: "api.routes.register" }],
};

export default manifest;
