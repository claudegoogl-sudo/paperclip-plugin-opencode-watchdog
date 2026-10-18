# paperclip-plugin-opencode-watchdog (`platform.opencode-watchdog`)

Event-driven rescue for `opencode_local` agents on OpenCode Zen free models.
When a run fails because the model is gone or no longer free, the plugin opens **one** rescue issue assigned to the CTO. The CTO picks a new free model (or falls back to Claude). **Healthy = nothing runs**: no timer polls, no LLM call, no write.

## Event flow

1. Host emits `agent.run.failed` (payload: `runId, agentId, status, error, errorCode, issueId`).
2. Filter, in order (all reads, no writes): agent allowlist -> not the rescue agent -> agent `adapterType == opencode_local` -> `error`/`errorCode` matches an error pattern -> the failing run's issue is not itself a rescue issue.
3. Debounce / loop guard (state below): max 1 rescue per agent per `debounceHours` (default 1); no new rescue while the agent's previous rescue issue is open.
4. Snapshot the Zen model list (one public GET) and create ONE issue: priority high, assignee = rescue agent (assignment wakes it). `originKind=plugin:platform.opencode-watchdog`, `originId=opencode-watchdog:<agentId>:<hour bucket>`.
5. The CTO follows the instructions in the issue body. The plugin never edits any agent (it holds no capability to).

Optional daily check (`proactiveEnabled`, default **off**): job `model-check` (06:23 daily) reads the Zen list only and raises the same rescue issue if an agent's `opencode/<id>` model is no longer served (`proactive_removed`) or no longer free (`proactive_no_longer_free`). Healthy = one GET and one log line. Flag off = the job returns immediately.

"Free" = id ends in `-free`, or `big-pickle`, or cost 0 for provider `opencode` in https://models.dev/api.json, and the id is served by `https://opencode.ai/zen/v1/models`.

## Error classes (default `errorPatterns`, case-insensitive regex)

| Class | Pattern source |
|---|---|
| Adapter refuses unknown model | `Configured OpenCode model is unavailable` |
| Provider says model missing | `ProviderModelNotFoundError`, `model ... (not found|does not exist|has been removed|deprecated ...)` |
| Free tier ended | `FreeTierError`, `no longer free`, `free ... (tier|usage|model) ... (ended|expired|exceeded|removed)` |
| Zen HTTP errors | `zen|opencode.ai` near `403|429|5xx` |

Fixtures: `tests/fixtures/errors.json` (positive and negative). Timeouts, exit codes, ENOENT, non-Zen 403s do **not** match.

## Install

```bash
pnpm install --frozen-lockfile && pnpm test && pnpm build && npm pack
# board / CTO installs the tgz as a local plugin; the plugin needs no secrets.
```

Config (JSON, per-company row or instance config; all optional):

| Key | Default | Meaning |
|---|---|---|
| `rescueAgentId` | null | Rescue assignee id. Wins over name. |
| `rescueAgentName` | `CTO` | Looked up in the failing agent's company. |
| `errorPatterns` | built-in list | Replaces the regex list. Invalid regexes are ignored. |
| `debounceHours` | 1 | Max one rescue per agent per N hours. |
| `agentAllowlist` | `[]` | Non-empty = ONLY these agent ids are ever watched. **Use this for a staged rollout (e.g. just OpenCodeTest).** |
| `proactiveEnabled` | false | Daily Zen list check. |
| `zenModelsUrl`, `modelsDevUrl` | Zen / models.dev | `https://` only. `modelsDevUrl: null` skips the catalog. |
| `dryRun` | false | Log what would be created; create nothing. |

## State

Plugin state (instance scope, namespace `opencode-watchdog`, key `agents`): `{ [agentId]: { companyId, lastRescueAt, rescueIssueId, previousModel, reason } }`.
`previousModel` is the model the agent had when the rescue was raised. Read it with the agent-auth route `GET /api/plugins/platform.opencode-watchdog/api/state` (returns the caller company only).

## Rollback

- Undo one rescue: `node scripts/restore-model.mjs --agent <id> --state-file state.json` (dry run), add `--apply` to PATCH only `adapterConfig.model` back. Or `--model <id>` instead of `--state-file`. Re-runs are no-ops. Needs `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` in env and an agent with `agents:configure`.
- Remove the plugin: disable, then uninstall `platform.opencode-watchdog`. It holds no side effects on agents. Open rescue issues stay; close them by hand. To go back to an older plugin version, reinstall the older tgz.
- Stop it without uninstalling: set `agentAllowlist` to a never-matching id, or `dryRun: true`.

## Safety

- Only write: `issues.create`. No agent PATCH, no LLM call, no secret read.
- Error text is truncated (`maxErrorChars`, 800) and common credential shapes are redacted before it enters an issue.
- A rescue issue's own failing runs, and failures of the rescue agent, never raise another rescue.
- Logs: `opencode_watchdog.started | skipped{why} | rescue_created | dry_run | proactive_healthy | proactive_list_unavailable | handler_error`. Metric: `opencode_watchdog.rescue_created`.

## Tests

`pnpm test` (mock event, mock Zen list, mock Paperclip API, SDK harness, restore script against a local HTTP server).
