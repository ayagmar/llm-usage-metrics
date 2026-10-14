# @ayagmar/agent-sessions

Parsers for the session logs that local coding agents (Claude Code, Codex, Gemini CLI, OpenCode and others) write to disk. Each source turns its agent's files into one normalized usage event shape, so tools can count tokens, sessions and active time across agents without knowing each log format. It is the parsing layer of [llm-usage-metrics](https://github.com/ayagmar/llm-usage-metrics), split out so other tools can use it.

The package is read-only: it makes no network calls, never writes to the agents' stores, and reads nothing (environment, home directory, files) at import.

This package is still being extracted from the CLI and has no stable API yet.

## Contents

- `@ayagmar/agent-sessions`: the usage event model and its normalization, the `SourceAdapter` contract, `SourceContext`, the parse fingerprint, `collect` and `collectFile`, `pipe`, and the dedup steps (`dedupeRepeatedAcrossFiles`, `dedupeCopiedSessions` and their stage forms, `computeEventContentHash`).
- `@ayagmar/agent-sessions/registry`: every source registered in a fixed order, with `createDefaultAdapters`, `getDefaultSourceIds` and per-source storage format and worker support.
- `@ayagmar/agent-sessions/sources/<id>`: one adapter per entry (`pi`, `codex`, `gemini`, `droid`, `opencode`, `openclaw`, `claude`, `copilot`, `goose`, `amp`, `qwen`, `kimi`, `cline`, `roocode`, `kilocode`, `antigravity`, `dsh`). Importing one entry loads no other source's code, except that `roocode` and `kilocode` load `cline`, whose family adapter builds them.
- `@ayagmar/agent-sessions/internal`: helpers the CLI still uses (parsing and discovery utilities, the SQLite loader, fingerprint and hash-count helpers). Not a public API.

## Reading a file

Every adapter has one read method:

```ts
read(filePath: string, options?: { diagnostics?: SourceReadDiagnostics }): AsyncIterable<Event>;
```

It yields the file's events in file order. Nothing is opened until the first `next()`. Rows the adapter skips go into `options.diagnostics` as they are found: `skippedRows` grows by one per row and `skippedRowReasons` counts each reason. Pass a sink from `createReadDiagnostics()` (in `./internal`) to read the counts; without one the adapter keeps them to itself. The counts are complete only once the read finishes.

A read can throw after it has yielded events. Those events are valid, but the file was not read to the end, and the sink counts after a throw mean nothing. When you need a file's events all or nothing, use `collectFile`:

```ts
import { collectFile } from '@ayagmar/agent-sessions';
import { CodexSourceAdapter } from '@ayagmar/agent-sessions/sources/codex';

const codex = new CodexSourceAdapter();

for (const filePath of await codex.discoverFiles()) {
  const { events, skippedRows, skippedRowReasons } = await collectFile(codex, filePath);
}
```

`collectFile` rejects with no events when the read throws, and returns `skippedRowReasons` sorted by reason. `collect(iterable)` turns any async iterable into an array.

### Stopping early

Breaking out of a `for await` loop calls `return()` on the read. Every handle the read opened (file streams, SQLite statements and databases) is closed before `return()` resolves, so it is safe to stop after the first event you need.

### Pausing holds the source open

A read holds its file or database while you iterate. For the SQLite sources (opencode, goose, antigravity) that is the read transaction, open until the read finishes or is returned: in WAL mode a snapshot the agent cannot checkpoint past, in rollback-journal mode a shared lock that blocks the agent's writes. Iterate to the end or `return()` promptly; do not await slow work between events of a SQLite read.

### Memory per source

Most sources hold one line, frame, array element or row at a time. Some keep state that grows with the file:

| Source                   | Reads                                                                                                       | State that grows with the file                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| pi, openclaw, qwen       | JSONL, one line at a time                                                                                   | none (pi keeps small fork state)                                                                                              |
| droid                    | one settings JSON document, plus its sibling JSONL                                                          | at most one event per file                                                                                                    |
| codex                    | JSONL, one line at a time                                                                                   | the response ids it has counted, and usage records waiting for the next `token_count` line                                    |
| claude                   | JSONL                                                                                                       | the whole file's events: they are deduplicated by message and request id and sorted by time, then yielded after the last line |
| copilot                  | JSONL                                                                                                       | the whole file's candidates: a later line can cancel an earlier one, so events are yielded after the last line                |
| kimi                     | JSONL                                                                                                       | `StatusUpdate` usage per message id, yielded after the `usage.record` events                                                  |
| dsh                      | JSONL, or zstd frames one at a time                                                                         | none (one compressed frame and its decoded lines)                                                                             |
| cline, roocode, kilocode | `ui_messages.json` one array element at a time, and a scan of `api_conversation_history.json` for the model | none                                                                                                                          |
| amp, gemini              | one JSON document of at most 64 MiB                                                                         | the whole document                                                                                                            |
| opencode, goose          | SQLite, one row at a time                                                                                   | none                                                                                                                          |
| antigravity              | SQLite, one row at a time                                                                                   | the response ids it has seen                                                                                                  |

## Stages

A stage is a function from one async iterable to another (`Stage<In, Out>`), and `pipe(source, ...stages)` runs a source through up to six of them. The dedup steps have stage forms next to their array functions:

- `repeatedAcrossFiles()` takes one batch of events per file, in file order, and drops events an earlier file already yielded. Use it for sources with `capabilities.eventsRepeatAcrossFiles` (pi forks copy their parent's entries). It keeps only a count per content hash.
- `copiedSessions()` drops events a continued session copied from the session it continues (`capabilities.sessionsCopyEvents`, claude). It buffers its whole input, since which session keeps a copy depends on every session's first event.

```ts
import { collect, pipe, repeatedAcrossFiles } from '@ayagmar/agent-sessions';
import { PiSourceAdapter } from '@ayagmar/agent-sessions/sources/pi';

const pi = new PiSourceAdapter();

async function* fileBatches() {
  for (const filePath of await pi.discoverFiles()) {
    yield await collect(pi.read(filePath));
  }
}

for await (const event of pipe(fileBatches(), repeatedAcrossFiles())) {
  console.log(event.sessionId, event.totalTokens);
}
```
