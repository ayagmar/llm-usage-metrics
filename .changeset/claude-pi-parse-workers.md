---
'@ayagmar/agent-sessions': patch
---

Claude and pi files can parse on CLI parse workers, as Codex files already do.

Changed (`@internal` names on `./registry`):

- `createWorkerParseAdapter(sourceId, roots)` takes the roots to build the adapter with,
  and builds Claude and pi adapters as well as Codex. A worker never resolves roots from its
  own home or environment, so a fork's parent is found exactly as in an inline parse.
- `getParseWorkerRoots(adapter, filePath)` gives those roots: the resolved roots of the
  adapter that owns the file, which for several directories of one source is that
  directory's adapter.
