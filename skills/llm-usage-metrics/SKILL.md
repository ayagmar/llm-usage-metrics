---
name: llm-usage-metrics
description: Answer questions about AI coding-tool spend and usage with the llm-usage CLI (npm package llm-usage-metrics), which reads local logs of 17 tools including Claude Code, Codex, Pi, Gemini CLI, OpenCode, and Copilot CLI. Covers cost and tokens by day, week, month, model, project, or session; period comparisons; estimated 5-hour plan windows and burn rate; API-priced value against a subscription; tool-call errors; prompt sizes; usage against Git activity; other machines over ssh; status lines; and HTML share reports. Use when someone asks how much they spent, which model or project costs the most, whether they are close to a plan window, which agent tools fail, or wants a usage report, export, or status line. Not for diagnosing why sessions wasted tokens through retries, compactions, or cache misses, or for recalling what a session said.
license: MIT
compatibility: Requires Node.js 22.16+ (not 23) or 24+, and npx or a global install of llm-usage-metrics. Reads local session logs of the supported coding tools; downloads LiteLLM model prices unless --pricing-offline.
---

# llm-usage-metrics

`llm-usage` reads the session logs that AI coding tools keep on this machine, normalizes them into one event history, and reports tokens and cost. A cost the tool logged is kept; otherwise it is estimated from LiteLLM list prices.

## Run it

- If `llm-usage --version` works, use `llm-usage`. Otherwise run `npx --yes llm-usage-metrics@latest <command>` (pin `llm-usage-metrics@<version>` in scripts). The examples below write `llm-usage`.
- Add `--json` whenever you read the numbers yourself (`events` writes JSONL instead). Stdout is `{"schemaVersion": 1, "report": "<name>", "data": ...}`; diagnostics go to stderr. `llm-usage schema <name>` prints the JSON Schema of the installed version (`schema --list` names them). Don't parse the terminal tables: they drop columns on narrow terminals.
- An empty report or a missing tool: run `llm-usage doctor`, which lists each source's search paths and whether it found usable logs.
- Before using a flag not shown here, check `llm-usage <command> --help`. Flags differ per command.

## Pick the command

| Question                                                      | Command                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Spend today, last 7 days, month to date, month-end projection | `llm-usage` (same as `llm-usage summary`)                                                                                |
| Usage per day, week, or month                                 | `daily` (last 7 days), `weekly` (last 8 weeks), `monthly` (all history); add `--by-repo` or `--by-machine` to split rows |
| Today hour by hour                                            | `hourly`                                                                                                                 |
| Which model costs the most                                    | `monthly --json` (rows carry `modelBreakdown`), or `--per-model-columns` in a table                                      |
| Which project costs the most                                  | `projects --top 10`                                                                                                      |
| Which conversations cost the most                             | `session --top 10`; group by project with `session --by-repo`                                                            |
| Why one session cost what it did                              | `session --id <id> --timeline`                                                                                           |
| Month to date against the same days last month                | `compare`; pick other windows with `--since`, `--until`, `--vs-since`, and `--vs-until`                                  |
| Am I near my plan window                                      | `blocks --source claude --last 1`                                                                                        |
| Is my subscription worth its price                            | `value --plan claude-max-5x` (other plan ids are listed in `value --help`)                                               |
| Which tools my agents call and which fail                     | `tools` (`tools --by-source`, `tools --by-repo`; Claude Code, Codex, and Pi only)                                        |
| Which sessions send the largest prompts                       | `context --by-session`                                                                                                   |
| Cost or tokens over time                                      | `trends --metric cost --last 14` (`tokens`, `active-hours`)                                                              |
| Usage against Git output                                      | `efficiency weekly --repo-dir <path>` (defaults to the repository containing the current directory)                      |
| Same usage priced on another model                            | `optimize monthly --provider openai --candidate-model <model>` (one provider per run)                                    |
| How a model name gets its price                               | `pricing <model>`                                                                                                        |
| A year in review                                              | `wrapped --year 2026`                                                                                                    |
| Raw events for other tools                                    | `events` (JSONL; `--format csv`)                                                                                         |

## Scope it

- Dates: `--since YYYY-MM-DD` and `--until YYYY-MM-DD` are inclusive, in the system timezone unless `--timezone <iana>`. `--last N` counts N days, weeks, or months (whichever the report uses; `hourly` counts days), including the current one. `--all` covers the full history. Each report has its own default window, as in the table above.
- Tools: `--source claude,codex` filters by the tool that wrote the log. `--provider anthropic` filters by billing provider, so a Codex session can be `source=codex` and `provider=openai`. `--model` filters by model name, exact if one matches, otherwise by substring.
- Projects: `--repo <path or name>` filters by project, the directory a session started in (usage after changing into a subfolder stays with it; on `events`, the directory each event recorded). A path matches that directory and those under it; a name such as `work/api` matches the end of a directory.
- Other machines: `llm-usage machine add <name> [ssh-target]` registers one (it needs llm-usage-metrics installed there and ssh without a prompt). Reports then include it and fetch its usage again when the cached copy is more than 10 minutes old. `--machine local` counts only this machine, `--no-sync` uses cached usage without ssh, `machine list` shows each machine's last sync, and `sync` fetches now.

## Read the numbers

- `$12.34` is fully priced, `~$12.34` leaves out events with no known price (stderr names their models), and `-` means nothing in the row had a price.
- Say whether a figure is logged or estimated. `--cost-mode explicit` keeps only costs the tools logged; `--cost-mode estimated` prices everything from tokens. On a subscription, an estimate is what the same tokens would cost at API prices, not the bill.
- `blocks` estimates 5-hour windows from the logs; providers don't record them and the CLI does not know the plan's quota. Report the active block's end time, minutes left, and burn rate, not a percentage of a limit.
- `--pricing-offline` skips the price download and uses cached or bundled prices.

## Status line and share reports

- `llm-usage statusline` prints one line: today's cost, the streak, and month to date. In Claude Code, the command `llm-usage statusline` in the `statusLine` setting of `~/.claude/settings.json` also shows the session's cost and context use. Suggest a global install (`npm install -g llm-usage-metrics`) for a status line, since npx resolves the package on every refresh. Ask before editing the user's settings.
- `--share` writes a self-contained HTML report to the current directory and opens it in the browser; `--no-open` only writes it. It works on `summary`, `daily`, `weekly`, `monthly`, `compare`, `trends`, `wrapped`, `efficiency`, and `optimize`. The file names projects, machines, and models; add `--redact` before someone shares it.

## Rules

- Run the CLI and quote its numbers with the window and filters used; never estimate spend from memory.
- Keep it read-only unless asked: `prune` previews until `--apply`, and `machine add`, `machine remove`, and `config init` change the user's config.
