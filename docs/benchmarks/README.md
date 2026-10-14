# Baseline benchmarks

`scripts/benchmark-baseline.mjs` times the built CLI over a synthetic corpus. Its
numbers are the baseline later changes compare against.

## Running it

```sh
pnpm run build
pnpm run bench:baseline
```

The script runs `node dist/bin.js`, the real entry with the V8 compile cache, so build
first. It writes
`<date>-baseline.json` and `<date>-baseline.md` to `docs/benchmarks/` unless you pass
`--out <dir>`.

Options:

- `--runs <count>`: timed runs per scenario (default 5).
- `--lines <count>`: lines per source, spread over 4 files (default 200000).
- `--out <dir>`: where to write the two report files.
- `--keep-temp`: keep the temp corpus and state directory for inspection.

A quick check that the script works:

```sh
pnpm run bench:baseline -- --runs 2 --lines 20000 --out /tmp/bench-smoke
```

## What it measures

The script generates pi and codex sessions in a temp directory, 4 files per source so
file-level parallelism is exercised, in the line shapes of `tests/fixtures/e2e-large`.
Usage lines are one minute apart and end a few minutes before the run, so today and this
month hold data. Every command passes
`--source pi,codex --pi-dir <dir> --codex-dir <dir>`, and runs with a temp `HOME`,
`XDG_CACHE_HOME`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME`, `LLM_USAGE_CONFIG_PATH`
pointing at a missing file, `LLM_USAGE_SKIP_UPDATE_CHECK=1`, `TZ=UTC`, and no
inherited `LLM_USAGE_*` or `NODE_*` variable, so a `NODE_OPTIONS` in your shell does not
reach the CLI. Stdin is ignored. `NODE_COMPILE_CACHE`, the one `NODE_*` variable the script
sets, points at a temp directory that one untimed priming run fills before any timed run. Nothing outside the
temp directory is read.

| Scenario       | What is timed                                                                                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cold`         | Store off, OS page cache warm: `daily --all --json --pricing-offline` with `LLM_USAGE_EVENT_STORE=0` and a fresh cache directory per run. The corpus was just written, so this is not a cold-disk number. |
| `warm`         | The same command with the event store on, after one priming run.                                                                                                                                          |
| `statusline`   | `statusline` with the event store on, after one priming run. It takes no `--pricing-offline` and reads no stdin.                                                                                          |
| `active-jsonl` | After one priming run on a copy of the corpus, each run appends 1000 new rows with later timestamps to the newest pi file and times `daily` once.                                                         |

Each scenario reports the median, minimum and maximum wall time over `--runs`, timed from
direct `node dist/bin.js` spawns, and the maximum RSS in MB from one extra untimed run (for
`active-jsonl`, after one more append). The RSS method is the first whose probe succeeds,
and the markdown names it:

- `gnu-time`: `/usr/bin/time -f %M`, when `/usr/bin/time -f %M true` succeeds.
- `python-rusage`: a `python3` wrapper that runs the CLI and reads `ru_maxrss` for
  `RUSAGE_CHILDREN`, when `python3 -c "import resource"` succeeds. `ru_maxrss` is KiB on
  Linux and bytes on macOS; the script converts by platform.
- `n/a`: neither works, so no RSS run happens.

The OS page cache is not flushed between runs.

The script fails if a report has no pi or codex usage, or if the event count from an
untimed `session --json` run after an `active-jsonl` run did not grow by the 1000
appended rows. A parser that skips the synthetic lines, or a stale cache hit, cannot
produce a fast but meaningless number.

## Committed results

`docs/benchmarks/<date>-baseline.md` files are this script's output, committed as a
record of the numbers on the machine named in each file. Compare runs from the same
machine only.
