import { Command } from 'commander';

import { formatHelpExamples } from './report-definitions/report-definitions.js';
import { runMachineExport, type MachineExportCommandOptions } from './run-machine-export.js';
import {
  runMachineAdd,
  runMachineList,
  runMachineRemove,
  runSync,
  type MachineAddOptions,
  type SyncCommandOptions,
} from './run-machine-commands.js';

export function createMachineCommand(): Command {
  const machineCommand = new Command('machine')
    .description('Combine usage from your other machines over ssh')
    .addHelpText(
      'after',
      formatHelpExamples([
        'llm-usage machine add laptop me@laptop.local',
        'llm-usage machine list',
        'llm-usage machine remove laptop',
      ]),
    );
  const addCommand = new Command('add')
    .description(
      'Sync a machine over ssh and add it to config.toml; it needs llm-usage-metrics installed and ssh login without a prompt',
    )
    .argument('<name>', 'Name for the machine in reports (lowercase letters, digits, dashes)')
    .argument('<ssh-target>', 'ssh destination: host, user@host, or an ssh_config alias')
    .option('--command <command>', 'How llm-usage-metrics is launched there (default: llm-usage)')
    .addHelpText(
      'after',
      formatHelpExamples([
        'llm-usage machine add laptop me@laptop.local',
        'llm-usage machine add vps vps --command /home/me/.local/bin/llm-usage',
      ]),
    )
    .action((name: string, sshTarget: string, options: MachineAddOptions) =>
      runMachineAdd(name, sshTarget, options),
    );
  const listCommand = new Command('list')
    .description('Show each machine, when it last synced, and how much usage is cached')
    .addHelpText('after', formatHelpExamples(['llm-usage machine list']))
    .action(() => runMachineList());
  const removeCommand = new Command('remove')
    .description('Remove a machine from config.toml and delete its cached usage')
    .argument('<name>', 'Machine name')
    .addHelpText('after', formatHelpExamples(['llm-usage machine remove laptop']))
    .action((name: string) => runMachineRemove(name));
  const exportCommand = new Command('export')
    .description(
      "Print the usage this machine's reports count, as a versioned NDJSON bundle that sync reads",
    )
    .option(
      '--known <path>',
      'Leave out files already held at the same revision, as listed in this JSON file (- for stdin)',
    )
    .option('--quiet', 'Suppress informational stderr output (warnings still print)')
    .option(
      '--verbose',
      'Print detailed diagnostics on stderr (per-source counts, routine skips, config, env)',
    )
    .addHelpText('after', formatHelpExamples(['llm-usage machine export > usage.ndjson']))
    .action((options: MachineExportCommandOptions) => runMachineExport(options));

  machineCommand.addCommand(addCommand);
  machineCommand.addCommand(listCommand);
  machineCommand.addCommand(removeCommand);
  machineCommand.addCommand(exportCommand);
  return machineCommand;
}

export function createSyncCommand(): Command {
  return new Command('sync')
    .description("Fetch your other machines' latest usage over ssh for reports to include")
    .argument('[names...]', 'Machines to sync (default: every enabled machine)')
    .option('--full', 'Fetch every file again instead of only the changed ones')
    .addHelpText('after', formatHelpExamples(['llm-usage sync', 'llm-usage sync laptop --full']))
    .action((names: string[], options: SyncCommandOptions) => runSync(names, options));
}
