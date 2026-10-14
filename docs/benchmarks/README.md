# Baseline benchmarks

`scripts/benchmark-baseline.mjs` times the built CLI over a synthetic corpus. Its
numbers are the baseline later changes compare against.

## Running it

```sh
pnpm run build
pnpm run bench:baseline
```

The script runs `node dist/index.js` directly, so build first. It writes
`<date>-baseline.json` and `<date>-baseline.md` to `docs/benchmarks/` unless you pass
`--out <dir>`.

Options:

- `--runs <count>`: timed runs per scenario (default 5).
- `--lines <count>`: lines per synthetic session file (default 200000).
- `--out <dir>`: where to write the two report files.
- `--keep-temp`: keep the temp corpus and state directory for inspection.

A quick check that the script works:

```sh
pnpm run bench:baseline -- --runs 2 --lines 20000 --out /tmp/bench-smoke
```

## What it measures

The script generates one pi session and one codex session in a temp directory, in the
line shapes of `tests/fixtures/e2e-large`. Usage lines are one minute apart and end a
few minutes before the run, so today and this month hold data. Every command passes
`--source pi,codex --pi-dir <dir> --codex-dir <dir>`, and runs with a temp `HOME`,
`XDG_CACHE_HOME`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME`, `LLM_USAGE_CONFIG_PATH`
pointing at a missing file, `LLM_USAGE_SKIP_UPDATE_CHECK=1`, `TZ=UTC`, and no
inherited `LLM_USAGE_*` variable. Nothing outside the temp directory is read.

| Scenario       | What is timed                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `cold`         | `daily --all --json --pricing-offline` with `LLM_USAGE_EVENT_STORE=0` and a fresh cache directory per run.        |
| `warm`         | The same command with the event store on, after one priming run.                                                  |
| `statusline`   | `statusline` with the event store on, after one priming run. It takes no `--pricing-offline` and reads no stdin.  |
| `active-jsonl` | After one priming run on a copy of the corpus, each run appends 1000 lines to the pi file and times `daily` once. |

Each scenario reports the median, minimum and maximum wall time over `--runs`, and the
maximum RSS in MB. RSS comes from `/usr/bin/time -f %M`; where that fails (macOS ships a
`time` without `-f`, and some Linux installs have no `/usr/bin/time`), the column says
`n/a`. The OS page cache is not flushed between runs.

The script fails if a report has no pi or codex usage, or if an `active-jsonl` run does
not count the lines appended before it, so a parser that skips the synthetic lines
cannot produce a fast but meaningless number.

## Committed results

`docs/benchmarks/<date>-baseline.md` files are this script's output, committed as a
record of the numbers on the machine named in each file. Compare runs from the same
machine only.
