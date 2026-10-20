# @ayagmar/agent-sessions

Parsers for the session logs that local coding agents (Claude Code, Codex, Gemini CLI, OpenCode and others) write to disk. Each source turns its agent's files into one normalized usage event shape, so tools can count tokens, sessions and active time across agents without knowing each log format. It is the parsing layer of [llm-usage-metrics](https://github.com/ayagmar/llm-usage-metrics), split out so other tools can use it.

The package is read-only: it makes no network calls, never writes to the agents' stores, and reads nothing (environment, home directory, files) at import. See [Security posture](#security-posture).

The package is at 0.x: see [Versioning](#versioning) for what is stable. Install it with `npm install @ayagmar/agent-sessions`.

The site has a guided introduction: [Reading and composing](https://ayagmar.github.io/llm-usage-metrics/library/guide/) walks through `readSources`, adapters, event kinds and the dedup stages with examples that run, and [Versioning and cursors](https://ayagmar.github.io/llm-usage-metrics/library/contracts/) covers stale events and resuming a read. This README is the full reference.

## Contents

- `@ayagmar/agent-sessions`: the usage event model and its normalization, the `SourceAdapter` contract, `SourceContext`, `getParserVersion`, `collect` and `collectFile`, `pipe`, the event kinds with `readEvents`, `kinds` and `isUsageRecord`, the stages `since`, `until` and `bySession`, the dedup steps (`dedupeRepeatedAcrossFiles`, `dedupeCopiedSessions` and their stage forms, `computeEventContentHash`, `dedupeToolCalls`), and the read cursor types.
- `@ayagmar/agent-sessions/registry`: every source registered in a fixed order, with `createDefaultAdapters`, `getDefaultSourceIds`, `getSourceStorageFormat` and `readSources`.
- `@ayagmar/agent-sessions/sources/<id>`: one adapter per entry (`pi`, `codex`, `gemini`, `droid`, `opencode`, `openclaw`, `claude`, `copilot`, `goose`, `amp`, `qwen`, `kimi`, `cline`, `roocode`, `kilocode`, `antigravity`, `dsh`). Importing one entry loads no other source's code, except that `roocode` and `kilocode` load `cline`, whose family adapter builds them.
- `@ayagmar/agent-sessions/otel`: experimental OpenTelemetry GenAI attributes for events. See [OpenTelemetry attributes](#opentelemetry-attributes).
- `@ayagmar/agent-sessions/internal`: helpers the CLI still uses (parsing and discovery utilities, the SQLite loader, fingerprint and hash-count helpers, provider normalization, terminal text helpers). Not a public API.

Importing `.` or `./internal` loads no source module; `./registry` loads them all.

The main entry also exports these helpers:

- `computeActiveMs(timestampsMs)`: the sum of the gaps between consecutive timestamps (sorted first), each gap capped at `IDLE_GAP_CAP_MS` (5 minutes). Zero for fewer than two timestamps.
- `computeUnionActiveMs(timestampLists)`: wall-clock active time across several sessions. Each list's capped gaps become intervals, and time covered by more than one list counts once.
- `normalizeTimestamp(value)`: a string or `Date` as an ISO 8601 UTC string; text with no offset reads as UTC. Throws on an invalid date.
- `normalizeSourceId(value)`: a source id with control characters stripped and whitespace trimmed, or `undefined` when the value is not a string or ends up empty.
- `getEventSessionKey(event)`: a key for an event's session, its `source` and `sessionId` joined by a NUL character, so equal session ids from two sources stay apart.
- `toParseDiagnostics(events, skippedRows, skippedRowReasons)`: packs a file's events and a reason-count map into the `SourceParseFileDiagnostics` shape `collectFile` returns, reasons sorted.

## Security posture

- **Read-only.** Adapters open files and databases for reading only. SQLite databases are opened with `readOnly: true`; SQLite itself may still update a WAL database's `-shm` index, as any reader does. The core writes no data to an agent's store and no files of its own. `./internal` also ships the CLI's file-writing helpers (`ensureDirectory`, `writeFileAtomic`), which no published entry calls yet.
- **No network.** The core imports no network module and calls no network API; lint enforces both.
- **Nothing read at import.** Importing any entry reads no file, environment variable or home directory. Host state comes from a `SourceContext`, filled when you call `createSourceContext()` or build an adapter.
- **Private text is opt-in.** Message text and session titles are set only with `text: true`, and the parsed source record only with `raw: true`. Without them, events carry counts, ids, models, timestamps, `cwd`, `repoRoot` and `gitBranch`. See [Privacy](#privacy).
- **No console output.** Problems an adapter does not throw for go to `context.onDiagnostic`.

What each source reads, by default. An explicit `dir` or `dbPath` replaces the default location.

| Source                   | Default location                                                                                                                                    | Also reads                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| pi                       | `~/.pi/agent/sessions`, `~/.omp/agent/sessions`                                                                                                     | a fork's parent session                                                       |
| codex                    | `$CODEX_HOME/sessions` (default `~/.codex/sessions`)                                                                                                |                                                                               |
| gemini                   | `$GEMINI_CLI_HOME/tmp/<project>/chats` (default `~/.gemini`)                                                                                        | `projects.json`, for each project's root                                      |
| droid                    | `~/.factory/sessions`                                                                                                                               | the JSONL next to each settings file                                          |
| opencode                 | `$XDG_DATA_HOME/opencode`, `~/.opencode`, Application Support or `%APPDATA%`                                                                        | the database's `-wal` and `-journal` files                                    |
| openclaw                 | `agents` under `~/.openclaw`, `~/.clawdbot`, `~/.moltbot` and `~/.moldbot`                                                                          |                                                                               |
| claude                   | `projects` and `transcripts` under each `$CLAUDE_CONFIG_DIR` entry (comma-separated; default `~/.claude`)                                           | a fork's parent transcript                                                    |
| copilot                  | `~/.copilot/otel`, and the file `$COPILOT_OTEL_FILE_EXPORTER_PATH` names                                                                            |                                                                               |
| goose                    | `$GOOSE_PATH_ROOT`, `$XDG_DATA_HOME`, Application Support or `%APPDATA%`                                                                            |                                                                               |
| amp                      | `$XDG_DATA_HOME/amp/threads` (default `~/.local/share/amp/threads`)                                                                                 |                                                                               |
| qwen                     | `~/.qwen/projects`                                                                                                                                  |                                                                               |
| kimi                     | `~/.kimi/sessions`, `~/.kimi-code/sessions`                                                                                                         | `config.json` next to the sessions directory                                  |
| cline, roocode, kilocode | the extension's VS Code and Cursor global storage (`~/.config/Code` and `~/.config/Cursor`, Application Support or `%APPDATA%`, `~/.vscode-server`) | `api_conversation_history.json` beside each `ui_messages.json`, for the model |
| antigravity              | `$GEMINI_CLI_HOME/antigravity-cli/conversations` (default `~/.gemini/antigravity-cli/conversations`)                                                |                                                                               |
| dsh                      | `$DSH_HOME/sessions` (default `~/.dsh/sessions`)                                                                                                    |                                                                               |

## Versioning

The package follows semver over its public subpaths: `.`, `./registry` and `./sources/<id>`. While it is at 0.x, a minor version may break them; a patch may not. Releases are versioned with changesets, separately from the CLI.

Outside that promise:

- `./internal`: helpers for the CLI, changed whenever the CLI needs to.
- `./otel`: experimental, see [OpenTelemetry attributes](#opentelemetry-attributes).
- Names tagged `@internal` on a public subpath: `canParseSourceOnWorker`, `createWorkerParseAdapter`, `getParseWorkerRoots` and `sourceSupportsDirectories` on `./registry`, `LEGACY_CODEX_MODEL_FALLBACK` on `./sources/codex`, and the test seams in the adapter options types (`defaultRootDirs`, `resolveDefaultDbPaths`, `pathExists`, `pathReadable`, `pathIsDirectory`, `pathIsFile`, `loadSqliteModule`, `sleep`).

Two versions tell a cache when stored events are stale:

- `CORE_EVENT_VERSION` goes up when shared normalization (`createUsageEvent` and the other constructors) would turn an unchanged file into different events.
- An adapter's `parserVersion` goes up when that adapter would parse an unchanged file differently: token mapping, dedup, model resolution.

`getParserVersion(adapter)` combines both. Key stored events on it, on the file, and on the files `getParseDependencies` returns.

The published tarball holds `dist`, `README.md`, `LICENSE`, `package.json` and, once versioned, `CHANGELOG.md`; `pnpm run core:pack:check` verifies that, that the package has no dependencies, and that each subpath loads on its own from an installed tarball.

## Reading a file

Every adapter has a usage read method:

```ts
read(filePath: string, options?: { diagnostics?: SourceReadDiagnostics }): AsyncIterable<Event>;
```

It yields the file's usage events in file order. To read messages, tool calls and session facts as well, see [Event kinds](#event-kinds). Nothing is opened until the first `next()`. Rows the adapter skips go into `options.diagnostics` as they are found: `skippedRows` grows by one per row and `skippedRowReasons` counts each reason. To read the counts, pass your own sink; without one the adapter keeps them to itself. The counts are complete only once the read finishes.

```ts
import type { SourceReadDiagnostics } from '@ayagmar/agent-sessions';

const diagnostics: SourceReadDiagnostics = { skippedRows: 0, skippedRowReasons: new Map() };

for await (const event of adapter.read(filePath, { diagnostics })) {
  // ...
}
```

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

A SQLite read that finds the database busy or locked is retried `maxBusyRetries` times (an adapter option, default 2; `0` turns retries off), waiting `busyRetryDelayMs` (default 50) times the attempt number before each retry. A `maxBusyRetries` that is not a non-negative integer throws when the adapter is created.

### Memory per source

Most sources hold one line, frame, array element or row at a time. Some keep state that grows with the file:

| Source                   | Reads                                                                                                       | State that grows with the file                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pi, openclaw, qwen       | JSONL, one line at a time                                                                                   | none (pi keeps small fork state)                                                                                                                                                                                                                                                                                                                          |
| droid                    | one settings JSON document, plus its sibling JSONL                                                          | at most one event per file                                                                                                                                                                                                                                                                                                                                |
| codex                    | JSONL, one line at a time                                                                                   | the response ids it has counted, and usage records waiting for the next `token_count` line                                                                                                                                                                                                                                                                |
| claude                   | JSONL                                                                                                       | the whole file's events: they are deduplicated by message and request id and sorted by time, then yielded after the last line                                                                                                                                                                                                                             |
| copilot                  | JSONL                                                                                                       | the whole file's candidates: a later line can cancel an earlier one, so events are yielded after the last line                                                                                                                                                                                                                                            |
| kimi                     | JSONL                                                                                                       | `StatusUpdate` usage per message id, yielded after the `usage.record` events                                                                                                                                                                                                                                                                              |
| dsh                      | JSONL, or zstd frames one at a time                                                                         | none (one compressed frame and its decoded lines). A frame runs to the next frame magic, so everything after the last magic is one frame, buffered to the end of the file even when it is not valid zstd (as before streaming, which read the whole file); while the buffer grows, the old and new buffers together can reach about three times the frame |
| cline, roocode, kilocode | `ui_messages.json` one array element at a time, and a scan of `api_conversation_history.json` for the model | none, except that a `<model>` tag inside an `<environment_details>` block followed by neither `</model>` nor `</environment_details>` keeps the rest of the history file                                                                                                                                                                                  |
| amp, gemini              | one JSON document of at most 64 MiB                                                                         | the whole document                                                                                                                                                                                                                                                                                                                                        |
| opencode, goose          | SQLite, one row at a time                                                                                   | none                                                                                                                                                                                                                                                                                                                                                      |
| antigravity              | SQLite, one row at a time                                                                                   | the response ids it has seen                                                                                                                                                                                                                                                                                                                              |

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

`since(bound)` and `until(bound)` keep events timestamped at or after `bound`, and before it. `since(t)` and `until(t)` split a stream in two, except that both drop an event whose timestamp does not parse. Bounds are compared as instants. An invalid bound throws when the stage is built, and so does a string bound with a time of day but no UTC offset (`'2026-06-01T10:00'`), which would mean different instants in different time zones. A date alone must be an ISO date (`'2026-06-01'`), which is midnight UTC; other date-only strings (`'2026/06/01'`, `'June 1, 2026'`) throw, since `Date.parse` reads them as local midnight. `bySession()` groups events into `{ source, sessionId, events }`, in the order each session first appears; it buffers its whole input.

## Reading every source

`readSources(context, ids, options)` on `./registry` reads every file of the listed sources and yields `SessionEvent`s. It takes the `readEvents` options (`kinds`, `text`, `raw`) plus `since`, `until`, `dedupe`, `diagnostics` and `roots`:

```ts
import { createSourceContext, kinds, pipe } from '@ayagmar/agent-sessions';
import { readSources } from '@ayagmar/agent-sessions/registry';

const context = createSourceContext();

for await (const usage of pipe(readSources(context, ['claude', 'codex']), kinds('usage'))) {
  console.log(usage.source, usage.model, usage.totalTokens);
}
```

- Sources come out in registry order, whatever order `ids` lists them in; files in discovery order; each file's events as `readEvents` yields them.
- `dedupe` (on by default) counts repeated usage once per source, as the CLI does: `repeatedAcrossFiles` for pi, then `copiedSessions` for claude. `since` and `until` apply after it.
- Buffering: with `dedupe` on, each file's events are collected before they are yielded, and a claude source is held in full until its last file, message bodies included when `text` or `raw` is on. `dedupe: false` streams.
- Failures: without `context.onDiagnostic`, a discovery or read failure is rethrown. With it, the failure is reported as a `warn` diagnostic and skipped: a failed discovery skips the source, a failed read skips the file. With `dedupe` on, a file whose read throws yields none of its events, as in the CLI. With `dedupe: false`, the events it yielded before the throw stay, which the CLI never counts.
- `roots` maps a source id to the directories to read instead of its defaults. An explicit root must exist, so a missing one is a discovery failure; a missing default root yields nothing and reports nothing. Each entry needs at least one root, and opencode and goose, which read one database file, take exactly one. An unknown id, a `roots` entry for a source not in `ids`, an empty entry, several roots for opencode or goose, or an invalid bound throws before any read.

### Another home directory

Adapters find their default locations from the context's home directory and environment. To read another user's home, or a copy of one:

```ts
const context = createSourceContext({ homeDir: '/mnt/backup/home/me', env: {} });
```

Pass `env: {}` as well when the home directory is all that should decide the locations. Without it the context holds `process.env`, and a `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, `XDG_DATA_HOME` or similar variable set on this machine moves those sources away from the home directory you passed. The forensics example's test uses `env: {}` for that reason.

## Resuming a read

An adapter whose `capabilities.incremental` is true can resume a JSONL file where an earlier read stopped: claude, pi and qwen. Check the flag before passing `resume`: any other adapter ignores `resume` and calls neither callback.

```ts
import type { ReadCursor } from '@ayagmar/agent-sessions';

let cursor: ReadCursor | undefined; // persisted between runs, per file

for await (const event of qwen.read(filePath, {
  resume: {
    from: cursor,
    onStart: ({ restarted, replaced }) => {
      if (restarted) dropStoredEventsFor(filePath);
      else dropLastStoredEventsFor(filePath, replaced ?? {});
    },
    onCursor: (update) => {
      cursor = update.cursor;
    },
  },
})) {
  store(event);
}
```

- `onStart` fires once when the read of the file starts, before any event, including for an empty file. `restarted: true` means the read starts from byte 0, so its events replace what you stored for the file; append only when it is false.
- `replaced` counts, per event kind, how many of the last events the previous read yielded this read yields again (claude and pi: usage a later row can still change, tool calls still waiting for a result). Drop them before appending.
- `onCursor` fires once, when the read completes. A read you break out of, or that throws, does not call it: keep the cursor you had. `partialLine: true` says the file ends in a line without a line feed, which the read left out.
- Per kind, the kept events followed by the resumed read's equal a full read; the interleaving across kinds can differ.
- A cursor is valid when its `parser` matches the adapter's (`<source>@<getParserVersion>`), the file is at least `offset` bytes long, and the sha256 of its first `offset` bytes matches `prefixHash`. Anything else restarts, so any change to the bytes the cursor covers reads the file again. Checking it reads those bytes once, without parsing them, and the resumed read extends the same hash.
- `offset` is the end of the last line-feed-terminated line. A final line without a line feed is not parsed, yielded or counted under `resume`; the next read sees it whole once its line feed arrives.
- `readEvents` forwards `resume` too, and honours it only when the read includes usage.

The cursor is plain JSON, so it can be stored as is. claude and pi keep their parse state in `JsonlReadCursor.state`; treat it as opaque. After a read with `raw: true`, that state holds the raw lines of the events and tool calls still open at `offset`, message text included, so store it as you store raw records.

## Per-request usage

A usage event with `singleRequest: true` records exactly one model request, so prices that depend on one request's prompt size, such as long-context tiers, can be applied to it. claude, gemini, pi, opencode (one event per step) and antigravity set it on every event. codex sets it on a per-response `token_usage_record` (Codex 0.153 and later) and on a `token_count` delta equal to that row's `last_token_usage`; a delta that spans several responses has no flag. droid and goose report session totals and never set it. An adapter passes `singleRequest: true` to `createUsageEvent` only for a record it knows covers one request.

## OpenTelemetry attributes

`@ayagmar/agent-sessions/otel` maps events to OpenTelemetry GenAI semantic-convention attributes: `usageRecordAttributes`, `toolCallAttributes` and `sessionAttributes`, each returning a plain `Record<string, string | number | boolean>`. It is experimental: the GenAI conventions have no release, so names follow the commit pinned in `SEMCONV_GENAI_REF` and can change when the pin moves, in any version. The helpers never emit message text, titles or raw records; paths and the git branch appear only with `includePaths: true`. `toolCallAttributes` marks a failed call with `error.type` = `_OTHER`.

## Example: session forensics

[`examples/session-forensics.ts`](examples/session-forensics.ts) reports, per claude, codex and pi session, the fresh input, cache read, cache write and output tokens, the recorded cost, the cache hit ratio (cache read / (fresh input + cache read); cache writes are left out), the count of system messages (Claude compaction summaries; Codex developer and injected-context messages), and how often the same user prompt was repeated in the session. It also counts prompts repeated across sessions. It reads with `text: true` but prints only counts and sha256 fingerprints. The fingerprints are unsalted, so a short or common prompt can be recovered by hashing guesses; do not share the output where the prompts themselves would be sensitive. Its core is one `pipe(readSources(...), kinds('usage', 'message'), bySession())` loop.

## Event kinds

`read` yields usage only. `readEvents(adapter, filePath, options)` reads the same file and yields `SessionEvent`, a union of four kinds. Every event has `kind`, `source`, `sessionId`, `timestamp` and, when asked for, `raw`:

| `kind`         | Type               | Other fields                                                                                                         |
| -------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `usage`        | `UsageRecord`      | every `UsageEvent` field, then `messageId`, `requestId` and `rawProvider` when known                                 |
| `message`      | `MessageEvent`     | `role` (`user`, `assistant` or `system`), `textLength`, and optionally `messageId`, `model` (assistant) and `text`   |
| `tool_call`    | `ToolCallEvent`    | `name`, `status` (`ok`, `error` or `unknown`), and optionally `toolCallId`, `completedAt`, `durationMs`, `messageId` |
| `session_meta` | `SessionMetaEvent` | any of `cwd`, `title`, `gitBranch`, `agentVersion`, `parentSessionId`, `model`, `rawProvider`                        |

A usage record has the same keys, in the same order, as the event `read` yields for it, followed by the ids. The other kinds leave out optional keys that have no value. `EVENT_KINDS` lists the four kinds.

```ts
type ReadEventsOptions = {
  kinds?: readonly EventKind[]; // default: every kind the adapter declares
  text?: boolean; // message text and session titles; default false
  raw?: boolean; // the parsed source record on each event; default false
  diagnostics?: SourceReadDiagnostics;
  resume?: ReadResume; // see Resuming a read
};
```

`read` is unchanged and stays the fast path for usage: the same events, order, line prefilter and diagnostics as before `readEvents` existed. Use it when usage is all you need. `readEvents` with `kinds: ['usage']` yields the same events as usage records with their ids.

`kinds(...wanted)` is a stage that keeps the listed kinds and narrows the type to them. `isUsageRecord(event)` narrows one event. Counting tool calls by name:

```ts
import { kinds, pipe, readEvents } from '@ayagmar/agent-sessions';
import { CodexSourceAdapter } from '@ayagmar/agent-sessions/sources/codex';

const codex = new CodexSourceAdapter();
const calls = new Map<string, number>();

for await (const call of pipe(readEvents(codex, filePath), kinds('tool_call'))) {
  calls.set(call.name, (calls.get(call.name) ?? 0) + 1);
}
```

Passing `kinds` to `readEvents` limits what it yields. A read of `['usage']` alone takes the `read` path; a read that includes any other kind parses the same lines whichever kinds it names.

### Kinds per source

`capabilities.kinds` lists the kinds an adapter produces. It is typed `readonly EventKind[]` (it was `readonly string[]`). claude, codex and pi declare all four kinds and implement `readEvents`. Every other source declares `['usage']`; for those, the core `readEvents` maps the `read` events to usage records with no ids, no `rawProvider` and no `raw`, even with `raw: true`. An adapter with no `capabilities.kinds` counts as `['usage']`.

Asking for a kind the adapter does not declare yields nothing for that kind; it is not an error. `kinds: []` yields nothing.

### Order

Within one file:

- usage records keep `read`'s order;
- a message or session_meta event is yielded at its record;
- a tool call is yielded when its result is seen. Calls with no result in the file are yielded at the end with status `unknown`, in the order they were made, before any usage the adapter holds until the end of the file;
- Claude sorts a file's usage by time at the end of the file, so its usage records come after every other kind.

The order is the same on every read of the same file. Every event from a file uses the same session id as that file's usage, so `source` plus `sessionId` joins kinds together.

### Privacy

`text` (message text) and `title` (session titles, which summarise content) are only set with `text: true`. `textLength` is always set. `raw` carries the full parsed record, text, tool inputs and tool outputs included, whether or not `text` is set. For a tool call `raw` is `{ call, result }` (Codex web searches: `{ call }`). For a Codex usage record it is the record that carries the tokens (`token_usage_record` when present, else `token_count`). `cwd` and `gitBranch` are always set, as usage `repoRoot` already is.

The core never sends data anywhere: it makes no network calls and writes nothing to the agents' stores.

### Ids and logged provider

| Source | Usage `messageId` / `requestId`                                                   | Usage `rawProvider`                                                            | Message and tool call `messageId`                    |
| ------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| claude | `message.id` / `requestId` (or `request_id`)                                      | `message.provider` when logged; usually not, the provider comes from the model | `message.id` of the assistant row                    |
| codex  | `token_usage_record.payload.response_id`; files with only `token_count` have none | `session_meta.payload.model_provider`                                          | messages: the `response_item` `id`; tool calls: none |
| pi     | `message.responseId`                                                              | the provider logged on the line, the message or the last `model_change`        | `message.responseId` of the assistant message        |

Sources that only declare `['usage']` carry no ids and no `rawProvider`.

### session_meta

A session_meta event carries partial facts. A field is set when a record states it and its value differs from the last one emitted for that field in the same session; a later value overrides an earlier one. The state is kept per session id, so when a file's records carry more than one session id (a pi fork of an uncounted parent, say), each session gets its own facts and `source` plus `sessionId` finds them. Claude states `cwd`, `gitBranch` and its version on every row, so most rows add nothing. No event is emitted with no fields. Once a Claude session has a custom title, later AI titles in it are ignored.

### Tool calls

A call is paired with its result by call id; the first call with an id wins. `completedAt` is the result record's timestamp, resolved as any record's is: a result with none takes the carried one. `status` is `error` when the result says so, `ok` when it does not, and `unknown` when the file has no result for the call or the source logs a status that is not recognised:

- claude: `tool_result.is_error`; `durationMs` from `toolUseResult.durationMs` when the row holds one result.
- codex: an output record means `ok` (Codex logs no error flag). `web_search_call` is a call named `web_search` that completes at its own record: `completed` is `ok`, `failed` is `error`, anything else is `unknown`. No `durationMs`.
- pi: `toolResult.isError` (`true` is `error`, `false` is `ok`); `durationMs` from the result when logged.

### Diagnostics

A usage-only `readEvents` records the same skipped rows as `read`. Asking for other kinds adds reason codes in three families:

- `<kind>_<reason>` for a row malformed for that kind, such as `message_invalid_user_message` or `session_meta_invalid_timestamp`. A record with no timestamp (Claude titles have none) takes the last earlier one in the file, or waits for the next one; it is skipped as `<kind>_invalid_timestamp` only when no later record has one either. A constructor that throws counts as `<kind>_event_creation_failed`;
- `other_json_parse_error` for a malformed line the usage prefilter would not have read; one it would have read counts as `json_parse_error`, and only when usage is requested;
- the tool-call codes, the same for every source and recorded only when `tool_call` is requested:
  - `tool_call_missing_id`: a call with no call id;
  - `tool_call_missing_name`: a call with an id but no name;
  - `tool_call_duplicate_id`: a call whose id an earlier call in the file had; the first call wins;
  - `tool_call_result_missing_id`: a result with no call id;
  - `tool_call_orphan_result`: a result whose call id no started call had, including a call skipped for a missing name. A second result for a call that already has one is dropped without a count.

The codes `read` can record are the ones without a `message_`, `tool_call_`, `session_meta_` or `other_` prefix. A read without `usage` records none of them.

### Dedup

`repeatedAcrossFiles()` and `copiedSessions()` dedupe usage only. Other kinds pass through unchanged, in their input order, and do not change which copy of a usage event is kept.

`dedupeToolCalls()` takes tool calls and keeps one per source and call id, the first read, with the status of the first copy that has a result. A resumed or forked transcript repeats its parent's calls under the same id. Calls without an id are all kept. `copiedSessions()` buffers its whole input, so with `text: true` it holds every message body until its input ends.

Forks:

- pi: a fork of a counted parent skips the entries it copied, for every kind. A fork of a parent that is not counted relabels them with the parent's session id, so two such forks of the same parent both yield the parent's messages and tool calls. That is the one cross-file repeat of other kinds left, and no stage drops it.
- Claude: rows a fork replays from its parent are skipped for every kind. Each fork still yields about one extra user message, its own instructions, which is not a copy of a parent row. The fork re-logs the parent's spawning call under a new row id; it is skipped as replayed, and the fork's result for it is dropped without a count.

### Mapping per source

- claude:
  - user rows with string content or text blocks are `user` messages. Rows holding only `tool_result` blocks yield none, `isMeta` rows yield none, and `isCompactSummary` rows are `system`.
  - each assistant row with text blocks is one message, so a response split over several rows can yield several. `<synthetic>`-model rows yield no message.
  - titles come from `ai-title` and `custom-title` rows; `cwd`, `gitBranch` and `version` (as `agentVersion`) from user and assistant rows.
- codex:
  - messages come from `response_item` `message` records only. `developer` is `system`. A user message whose text blocks all start with context Codex injects (`<environment_context>`, `<user_instructions>`, `# AGENTS.md instructions`, `<skill>`, `<turn_aborted>`, `<user_action>`, `<user_shell_command>`) is `system`; only prompts the person typed are `user`.
  - tool calls are `function_call` and `custom_tool_call`, paired with their `_output` records by `call_id`, plus `web_search_call`.
  - session facts come from `session_meta` (`cwd`, `cli_version`, `git.branch`, `model_provider`) and `turn_context` (`model`).
- pi:
  - messages are `user`, `assistant` and `system` entries with text; `toolResult` entries are not messages, and neither are assistant entries with only thinking or tool calls.
  - tool calls are assistant `toolCall` blocks paired with `toolResult` entries.
  - session facts come from the `session` header (`cwd`, and `parentSession` as the parent's session id), `session_info.name` (`title`) and `model_change` (`model` and `rawProvider`).

In every message, `text` joins the record's text blocks with a blank line, unchanged; thinking blocks are left out.
