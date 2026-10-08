import {
  isValidMachineName,
  isValidSshTarget,
  LOCAL_MACHINE_NAME,
  loadUserConfig,
  resolveUserConfigPath,
  type MachineConfig,
} from '../config/user-config.js';
import { deleteMachineCache, readMachineCacheStatus } from '../machines/machine-cache.js';
import {
  addMachineToConfigFile,
  hasMachineEntry,
  removeMachineFromConfigFile,
} from '../machines/machine-config-file.js';
import { detectRemoteCommand, type SpawnSsh } from '../machines/machine-ssh.js';
import { syncMachine } from '../machines/sync-machine.js';
import { renderMachineList, renderSyncOutcome } from '../render/render-machines.js';
import { logger } from '../utils/logger.js';

export type MachineCommandDeps = {
  spawnSsh?: SpawnSsh;
  now?: () => number;
  print?: (line: string) => void;
};

export type MachineAddOptions = { command?: string };
export type SyncCommandOptions = { full?: boolean };

async function loadConfiguredMachines(): Promise<Record<string, MachineConfig>> {
  const loaded = await loadUserConfig();

  for (const warning of loaded.warnings) {
    logger.warn(warning);
  }

  return loaded.config.machines ?? {};
}

export async function runMachineAdd(
  name: string,
  sshTarget: string,
  options: MachineAddOptions,
  deps: MachineCommandDeps = {},
): Promise<void> {
  const print = deps.print ?? console.log;

  if (!isValidMachineName(name)) {
    throw new Error(
      `Invalid machine name "${name}": use 1-32 lowercase letters, digits or dashes (not "${LOCAL_MACHINE_NAME}")`,
    );
  }

  if (!isValidSshTarget(sshTarget)) {
    throw new Error(
      `Invalid ssh destination "${sshTarget}": use host, user@host or an ssh_config alias`,
    );
  }

  const configPath = resolveUserConfigPath(process.env);

  if (Object.hasOwn(await loadConfiguredMachines(), name)) {
    throw new Error(
      `Machine ${name} is already configured in ${configPath}; pick another name or run llm-usage machine remove ${name}`,
    );
  }

  if (await hasMachineEntry(configPath, name)) {
    throw new Error(
      `${configPath} already has a machines.${name} entry that is not valid (see the warning above); fix or delete it first`,
    );
  }

  let command = options.command?.trim();

  if (!command) {
    command = await detectRemoteCommand(sshTarget, { spawnSsh: deps.spawnSsh });

    if (command) {
      logger.info(
        `${sshTarget} finds llm-usage only in a login shell; launching it with: ${command}`,
      );
    }
  }

  const machine: MachineConfig = command ? { ssh: sshTarget, command } : { ssh: sshTarget };

  logger.info(
    `Syncing ${name} over ssh (${sshTarget}); its first export parses that machine's logs and can take a while...`,
  );
  // A cache left by an earlier machine of this name must not mix into the new one.
  await deleteMachineCache(name);
  const outcome = await syncMachine(name, machine, {
    full: true,
    spawnSsh: deps.spawnSsh,
    now: deps.now,
  });

  if (!outcome.ok) {
    await deleteMachineCache(name);
    throw new Error(`Could not add ${name}: ${outcome.error}`);
  }

  await addMachineToConfigFile(configPath, name, machine);

  for (const line of renderSyncOutcome(outcome, (deps.now ?? Date.now)())) {
    print(line);
  }

  print(
    `Added ${name} to ${configPath}. Reports now include its usage; llm-usage sync fetches it again.`,
  );
}

export async function runMachineRemove(name: string, deps: MachineCommandDeps = {}): Promise<void> {
  const print = deps.print ?? console.log;
  const configPath = resolveUserConfigPath(process.env);

  if (!Object.hasOwn(await loadConfiguredMachines(), name)) {
    throw new Error(`No machine named ${name} in ${configPath}`);
  }

  await removeMachineFromConfigFile(configPath, name);
  await deleteMachineCache(name);
  print(`Removed ${name} from ${configPath} and deleted its cached usage.`);
}

export async function runMachineList(deps: MachineCommandDeps = {}): Promise<void> {
  const print = deps.print ?? console.log;
  const machines = await loadConfiguredMachines();
  const entries = await Promise.all(
    Object.entries(machines).map(async ([name, machine]) => {
      const status = await readMachineCacheStatus(name);

      return {
        name,
        machine,
        state: status?.state,
        fileCount: status?.fileCount ?? 0,
        eventCount: status?.eventCount ?? 0,
      };
    }),
  );

  for (const line of renderMachineList(entries, (deps.now ?? Date.now)())) {
    print(line);
  }
}

/** Syncs the named machines, or every enabled one; fails if any sync fails. */
export async function runSync(
  names: readonly string[],
  options: SyncCommandOptions,
  deps: MachineCommandDeps = {},
): Promise<void> {
  const print = deps.print ?? console.log;
  const machines = await loadConfiguredMachines();
  const unknownNames = names.filter((name) => !Object.hasOwn(machines, name));

  if (unknownNames.length > 0) {
    const configured = Object.keys(machines);
    throw new Error(
      `Unknown machine(s): ${unknownNames.join(', ')}${configured.length > 0 ? ` (configured: ${configured.join(', ')})` : ''}`,
    );
  }

  const selected = Object.entries(machines).filter(([name, machine]) =>
    names.length > 0 ? names.includes(name) : machine.enabled !== false,
  );

  if (selected.length === 0) {
    print(
      Object.keys(machines).length === 0
        ? 'No machines configured. Add one with: llm-usage machine add <name> <user@host>'
        : 'Every machine is disabled; name one to sync it anyway.',
    );
    return;
  }

  // No timeout: a first export can parse for minutes, and Ctrl-C stops it. Each machine
  // prints as soon as it finishes.
  const outcomes = await Promise.all(
    selected.map(async ([name, machine]) => {
      const outcome = await syncMachine(name, machine, {
        full: options.full,
        spawnSsh: deps.spawnSsh,
        now: deps.now,
      });

      for (const line of renderSyncOutcome(outcome, (deps.now ?? Date.now)())) {
        print(line);
      }

      return outcome;
    }),
  );

  if (outcomes.some((outcome) => !outcome.ok)) {
    process.exitCode = 1;
  }
}
