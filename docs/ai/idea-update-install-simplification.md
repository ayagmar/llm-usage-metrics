# Idea #7: Simplify interactive update install

> Status: **Approved & implemented on `feat/improvements` (2026-07)** — the
> maintainer approved the product change on 2026-07-05; the CLI now prints a
> non-blocking stderr hint and never prompts, installs, or restarts.
> Confidence: **70%** — fixes the most fragile subsystem, but removes a
> documented feature.

## The problem this solves

The update subsystem (`src/update/`) is the **most complex, fragile code
relative to its job** in the codebase. It just shipped a real cross-command
consistency bug (PR #117: stale cache → background refresh → no prompt on one
command, prompt on the next). Even after that fix, the core interactive path
was the single riskiest code in the tool:

```ts
// src/update/update-install-runner.ts (deleted when this idea shipped)
export async function runInteractiveInstallAndRestart(options) {
  const installAccepted = await confirmInstall(installPromptMessage); // readline [y/N]
  if (!installAccepted) return { continueExecution: true };

  // 1. Run a global install that mutates the user's environment:
  const installExitCode = await runCommand(npmCommand,
    ['install', '-g', `${packageName}@latest`], { stdio: 'inherit' });

  // 2. Re-exec the CLI with the original argv, inheriting stdio:
  const restartExitCode = await runCommand(execPath, restartArgs, {
    env: { ...env, [skipUpdateCheckEnvVar]: '1' }, stdio: 'inherit' });

  return { continueExecution: false, exitCode: restartExitCode };
}
```

Risks this path carries:

- **`npm install -g` mutates the user's global environment** from within a
  reporting tool. A failed/partial install can leave the global install broken.
- **Process re-exec** (`runCommand(execPath, argv)` with `stdio: 'inherit'`)
  replaces the user's intended command with a child process. Signal handling,
  exit codes, and the original `process.argv` shape are fragile across
  platforms/shells.
- **The readline prompt** blocks the CLI on `process.stdin`, which is exactly
  what caused the test flakiness fixed in the earlier commit (race between the
  mock and the real readline binding).
- **Complexity budget.** The subsystem has ~7 modules
  (`update-notifier`, `update-cache-repository`, `update-install-runner`,
  `version-utils`, runtime config, env var overrides, plus the CLI entry hook)
  to do "tell the user a newer version exists."

## The idea

Replace the interactive install + re-exec with a **non-blocking update hint**,
matching how most modern CLIs behave (e.g. `npm`, `pnpm` itself):

```ts
// src/update/update-notifier.ts — simplified tail of checkForUpdatesAndMaybeRestart
if (!isInteractiveSession({ env, stdinIsTTY, stdoutIsTTY })) {
  notify(`${updateMessage} Run "npm install -g ${packageName}@latest" to update.`);
  return { continueExecution: true };
}

// Interactive sessions: print the hint to stderr and continue. No prompt,
// no global install, no re-exec.
notify(`${updateMessage} Run "npm install -g ${packageName}@latest" to update.`);
return { continueExecution: true };
```

What gets removed:

- `runInteractiveInstallAndRestart` and the entire interactive branch
- `defaultConfirmInstall` + the readline `createInterface` dependency
- `runCommandWithSpawn` usage for install/restart
- The `UpdateInstallRestartResult`/`confirmInstall`/`runCommand` option plumbing
- The flaky readline test path entirely

What stays:

- `checkForUpdatesAndMaybeRestart` (now just "check + notify")
- the bounded fetch + cache (the PR #117 fix)
- `isInteractiveSession` / skip predicates / env vars

## Why it is a good improvement

- **Deletes the riskiest code path.** No more global mutation or process
  re-exec from a reporting tool.
- **Removes the flaky readline test surface** (the test that was intermittently
  timing out at 5s).
- **~150+ lines of subsystem code gone**, and with it the `src/update/update-install-runner.ts`
  module almost entirely.
- **Predictable behavior.** The CLI never blocks on stdin; it always reports and
  continues. Users who want the update run the documented command themselves.

## Possible downsides

- **It removes a documented feature.** The README "Update Checks" section
  previously documented interactive prompting in TTY sessions. Removing it was
  a **product decision**, not a pure improvement — some users may value the
  one-step install. This is why I did not implement it unilaterally.
- **Slightly worse UX for users who relied on the prompt.** They now see a hint
  and must run the install command themselves.
- **Migration.** Needs a release-note line and a README update so the behavior
  change is communicated, not silent.

## Confidence

**70%.** The engineering case is strong (delete fragile code, remove a real bug
class), but the 30% reservation is entirely about product fit — only the
maintainer can decide whether the interactive install is a feature to keep.
If approved, this is a small, surgical change (mostly deletion).

## Suggested first step (if approved)

Gut `runInteractiveInstallAndRestart` so both interactive and non-interactive
paths emit the same `notify(...)` hint and `return { continueExecution: true }`.
Delete `defaultConfirmInstall`, the readline import, and the install/restart
`runCommand` plumbing. Update the README "Update Checks" bullets and the
`update-install-runner` tests.
