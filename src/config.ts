import { DEFAULT_ERROR_PATTERNS } from "./detect.js";

export interface WatchdogConfig {
  /** Agent that receives rescue issues. Wins over `rescueAgentName`. */
  rescueAgentId: string | null;
  /** Fallback: agent name looked up in the failing agent's company (case-insensitive). */
  rescueAgentName: string;
  /** Regex sources (case-insensitive) for the model-unavailable error class. */
  errorPatterns: string[];
  /** Max one rescue per agent per this many hours. */
  debounceHours: number;
  /** If non-empty, ONLY these agent ids are ever watched. Empty = every opencode_local agent. */
  agentAllowlist: string[];
  /** Agent ids that are NEVER watched for rescue. Wins over `agentAllowlist`. Empty = none denied. */
  agentDenylist: string[];
  /** Daily model-list check. OFF by default. */
  proactiveEnabled: boolean;
  zenModelsUrl: string;
  /** Optional catalog used to also treat cost-0 models as free. null disables it. */
  modelsDevUrl: string | null;
  maxErrorChars: number;
  /** Directory of pre-migration agent snapshots; named in the rescue body only. */
  snapshotDir: string | null;
  /** Daily new-free-model check: opens one re-benchmark issue. OFF by default. */
  newModelWatchEnabled: boolean;
  /** Agent that receives re-benchmark issues. Wins over `benchmarkAgentName`. */
  benchmarkAgentId: string | null;
  benchmarkAgentName: string;
  /** Optional parent for re-benchmark issues. */
  benchmarkParentIssueId: string | null;
  /** Log what would be created, write nothing. */
  dryRun: boolean;
}

export const DEFAULT_CONFIG: WatchdogConfig = {
  rescueAgentId: null,
  rescueAgentName: "Concierge",
  errorPatterns: [...DEFAULT_ERROR_PATTERNS],
  debounceHours: 1,
  agentAllowlist: [],
  agentDenylist: [],
  proactiveEnabled: false,
  zenModelsUrl: "https://opencode.ai/zen/v1/models",
  modelsDevUrl: "https://models.dev/api.json",
  maxErrorChars: 800,
  snapshotDir: null,
  newModelWatchEnabled: false,
  benchmarkAgentId: null,
  benchmarkAgentName: "CTO",
  benchmarkParentIssueId: null,
  dryRun: false,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const https = (v: unknown, d: string | null) => (typeof v === "string" && /^https:\/\/[^\s]+$/.test(v) ? v : v === null ? null : d);

export function parseConfig(raw: unknown): WatchdogConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_CONFIG;
  const strs = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 300).slice(0, max) : null);
  const patterns = strs(r.errorPatterns, 50);
  return {
    rescueAgentId: typeof r.rescueAgentId === "string" && UUID.test(r.rescueAgentId) ? r.rescueAgentId : null,
    rescueAgentName: typeof r.rescueAgentName === "string" && r.rescueAgentName.trim() ? r.rescueAgentName.trim() : d.rescueAgentName,
    errorPatterns: patterns && patterns.length ? patterns : [...d.errorPatterns],
    debounceHours: typeof r.debounceHours === "number" && r.debounceHours >= 0.01 && r.debounceHours <= 168 ? r.debounceHours : d.debounceHours,
    agentAllowlist: (strs(r.agentAllowlist, 100) ?? []).filter((x) => UUID.test(x)),
    agentDenylist: (strs(r.agentDenylist, 100) ?? []).filter((x) => UUID.test(x)),
    proactiveEnabled: r.proactiveEnabled === true,
    zenModelsUrl: https(r.zenModelsUrl, d.zenModelsUrl) ?? d.zenModelsUrl,
    modelsDevUrl: r.modelsDevUrl === null ? null : https(r.modelsDevUrl, d.modelsDevUrl),
    maxErrorChars: typeof r.maxErrorChars === "number" && r.maxErrorChars >= 100 && r.maxErrorChars <= 4000 ? r.maxErrorChars : d.maxErrorChars,
    snapshotDir: typeof r.snapshotDir === "string" && r.snapshotDir.trim() && r.snapshotDir.length <= 300 ? r.snapshotDir.trim() : null,
    newModelWatchEnabled: r.newModelWatchEnabled === true,
    benchmarkAgentId: typeof r.benchmarkAgentId === "string" && UUID.test(r.benchmarkAgentId) ? r.benchmarkAgentId : null,
    benchmarkAgentName: typeof r.benchmarkAgentName === "string" && r.benchmarkAgentName.trim() ? r.benchmarkAgentName.trim() : d.benchmarkAgentName,
    benchmarkParentIssueId: typeof r.benchmarkParentIssueId === "string" && UUID.test(r.benchmarkParentIssueId) ? r.benchmarkParentIssueId : null,
    dryRun: r.dryRun === true,
  };
}

export const CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rescueAgentId: { type: "string", format: "uuid", title: "Rescue agent id" },
    rescueAgentName: { type: "string", default: "Concierge", title: "Rescue agent name (used when no id is set)" },
    errorPatterns: { type: "array", items: { type: "string" }, title: "Model-unavailable error regexes (case-insensitive)" },
    debounceHours: { type: "number", minimum: 0.01, maximum: 168, default: 1, title: "Max one rescue per agent per N hours" },
    agentAllowlist: { type: "array", items: { type: "string", format: "uuid" }, title: "Only watch these agents (empty = all opencode_local agents)" },
    agentDenylist: { type: "array", items: { type: "string", format: "uuid" }, title: "Never watch these agents (wins over agentAllowlist)" },
    proactiveEnabled: { type: "boolean", default: false, title: "Daily model-list check (no LLM, read-only)" },
    zenModelsUrl: { type: "string", default: DEFAULT_CONFIG.zenModelsUrl },
    modelsDevUrl: { type: ["string", "null"], default: DEFAULT_CONFIG.modelsDevUrl },
    maxErrorChars: { type: "number", minimum: 100, maximum: 4000, default: 800 },
    snapshotDir: { type: ["string", "null"], default: null, title: "Directory of pre-migration agent snapshots (<dir>/<agentId>.json)" },
    newModelWatchEnabled: { type: "boolean", default: false, title: "Daily new-free-model check (opens a re-benchmark issue)" },
    benchmarkAgentId: { type: "string", format: "uuid", title: "Benchmark agent id" },
    benchmarkAgentName: { type: "string", default: "CTO", title: "Benchmark agent name (used when no id is set)" },
    benchmarkParentIssueId: { type: "string", format: "uuid", title: "Parent issue for re-benchmark issues" },
    dryRun: { type: "boolean", default: false, title: "Dry run: log, create nothing" },
  },
} as const;
