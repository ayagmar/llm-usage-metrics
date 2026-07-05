# Idea #4: `llm-usage doctor` diagnostic command

> Confidence: **85%** — small, isolated, high immediate user value. Not started
> only to keep PR #119 focused. **Best first pick** from the deferred set.

## The problem this solves

The most common user pain point is **"No sessions found"** — the troubleshooting
page exists precisely for this. Today a user has to manually run a sequence of
scoped `--source` commands, check each `--*-dir`, verify OpenCode's sqlite
runtime, and inspect env vars to figure out why a source produced nothing. There
is no single command that answers "is my setup healthy?"

This is especially painful for:

- **OpenCode** — requires Node 24 built-in `node:sqlite`, auto-discovery across
  OS-specific paths, and a valid DB. Three independent failure modes, none
  surfaced until a report silently omits the source.
- **Claude** — newest source; users adding it hit discovery/path questions.
- **Custom `--source-dir` / `--*-dir` overrides** — a typo silently yields zero
  events with no explanation.

## The idea

A new `llm-usage doctor` command that runs the **discovery + parse-health
checks** for every source and prints a structured pass/fail report, without
doing any aggregation or pricing. It is purely diagnostic.

### Output shape (terminal)

```
$ llm-usage doctor
llm-usage doctor

  pi        ✓  12 sessions found  (~/.pi/agent/sessions)
  codex     ✓   8 sessions found  (~/.codex/sessions)
  gemini    ✓   3 chats found     (~/.gemini)
  droid     ✓   5 sessions found  (~/.factory/sessions)
  opencode  ✗  node:sqlite unavailable (requires Node 24+)
  openclaw  ✓   4 sessions found  (~/.openclaw/agents)
  claude    ✓  27 projects found  (~/.claude/projects)

  pricing   ✓  LiteLLM cache fresh (fetched 2h ago)
  env       ✓  LLM_USAGE_SKIP_UPDATE_CHECK unset

  6/7 sources healthy. opencode skipped: runtime missing node:sqlite.
```

### `--json` shape

```json
{
  "sources": [
    { "id": "pi", "status": "ok", "itemsFound": 12, "discoveredPath": "~/.pi/agent/sessions" },
    { "id": "opencode", "status": "error", "error": "node:sqlite unavailable (requires Node 24+)" },
    { "id": "openclaw", "status": "ok", "itemsFound": 4, "discoveredPath": "~/.openclaw/agents" }
  ],
  "pricing": { "status": "ok", "origin": "cache", "fetchedAt": "2026-06-25T08:00:00Z" },
  "env": { "LLM_USAGE_SKIP_UPDATE_CHECK": null }
}
```

### Implementation sketch

```ts
// src/cli/report-definitions/report-definitions.ts
const doctorReportDefinition: ReportRuntimeDefinition = {
  meta: {
    commandName: 'doctor',
    docsLabel: 'doctor',
    kind: 'specialized',
    description: 'Check source discovery, parse health, and runtime config',
    sharedOptionProfile: 'specialized', // reuse --*-dir flags, no pricing/markdown
    helpExamples: [{ command: 'llm-usage doctor', includeInRootHelp: true }],
  },
  register(command) {
    command.action((options) => runDoctorReport(options));
    return command;
  },
};
```

```ts
// src/cli/run-doctor-report.ts (new)
export async function runDoctorReport(options: ReportCommandOptions): Promise<void> {
  const adapters = createDefaultAdapters(options);
  const results = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        const files = await adapter.discoverFiles();
        return { id: adapter.id, status: 'ok' as const, itemsFound: files.length };
      } catch (error) {
        return { id: adapter.id, status: 'error' as const, error: errorMessage(error) };
      }
    }),
  );

  if (options.json) {
    process.stdout.write(JSON.stringify({ sources: results, ... }, null, 2));
    return;
  }

  renderDoctorTable(results); // terminal table, stderr diagnostics
}
```

Key design points:

- **Reuses `createDefaultAdapters`** so doctor sees exactly what a real report
  sees — no separate discovery logic to drift.
- **Only calls `discoverFiles()`**, never `parseFile`. Fast, and surfaces
  path/permission/runtime errors without depending on parse correctness.
- **Honors the existing `--*-dir` / `--source-dir` flags** so users can debug a
  custom path: `llm-usage doctor --claude-dir /maybe/wrong/path`.
- **Output on stdout for `--json`**, diagnostics on stderr — matches the
  existing CLI output rules in AGENTS.md.

## Why it is a good improvement

- **Collapses the troubleshooting page into one command.** The most common
  support question ("why no sessions?") gets a direct, actionable answer.
- **Reuses existing seams** (`createDefaultAdapters`, `discoverFiles`, the shared
  option profile) — almost no new plumbing, no new contracts.
- **Isolated.** A new command + one new file; touches nothing in the report
  pipeline. Zero regression risk to existing reports.
- **Composable with the bigger ideas.** It is the natural home for the event
  store health check (idea #1) and a `--rebuild-store` sanity check later.

## Possible downsides

- **One more command to maintain + document.** Small, but real. Needs a
  `doctor.mdx` page, a sidebar entry, and a CLI-reference regeneration.
- **`discoverFiles()` is not a perfect health signal.** A source can discover
  files but fail to parse them. A v2 could optionally parse one sample file per
  source, but v1 should stay discovery-only to keep it fast and safe.
- **OpenCode `node:sqlite` check needs a guarded `import('node:sqlite')`.** That
  probe already exists in the opencode adapter path; doctor should surface it
  explicitly rather than letting it throw opaquely.

## Confidence

**85%.** This is the highest-confidence idea in the deferred set: small,
self-contained, fits the existing architecture, and addresses a documented user
pain point directly. The 15% reservation is only that it adds a command + doc
surface to maintain.

## Suggested first step

Add `runDoctorReport` + the `doctor` definition calling only `discoverFiles()`
for each adapter, with terminal + `--json` output. Ship without the
pricing/env sections first; add those once the source-health core lands.
