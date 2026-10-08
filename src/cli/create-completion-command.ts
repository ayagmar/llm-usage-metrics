import { Command } from 'commander';

import { formatHelpExamples } from './report-definitions/report-definitions.js';
import { getSupportedSourceIds } from './report-definitions/shared-report-options.js';

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** Both installed bin names complete the same way. */
const PROGRAM_NAMES = ['llm-usage', 'llm-usage-metrics'] as const;

type CompletionOption = {
  flag: string;
  description: string;
  takesValue: boolean;
};

type CompletionCommand = {
  name: string;
  description: string;
  options: CompletionOption[];
  /** Subcommand names and known positional argument values. */
  words: string[];
  subcommands: CompletionCommand[];
};

/** Option values worth completing: source ids for --source, files for paths. */
type ValueCompletions = {
  sourceFlags: string[];
  pathFlags: string[];
  sourceIds: string[];
};

// Flags named for a directory or database take a path. `--source-dir` is the exception:
// its value is `<source-id>=<path>`, which plain file completion would get wrong.
function isPathFlag(flag: string): boolean {
  return (
    (flag.endsWith('-dir') && flag !== '--source-dir') ||
    flag.endsWith('-db') ||
    flag === '--pricing-overrides' ||
    flag === '--repo-dir'
  );
}

function describeCommand(
  command: Command,
  argumentValues: Readonly<Record<string, readonly string[]>>,
): CompletionCommand {
  const options = command.options.flatMap((option): CompletionOption[] =>
    option.long
      ? [
          {
            flag: option.long,
            description: option.description,
            takesValue: option.required || option.optional,
          },
        ]
      : [],
  );
  const subcommands = command.commands.map((subcommand) =>
    describeCommand(subcommand, argumentValues),
  );

  return {
    name: command.name(),
    description: command.description().split('\n')[0] ?? '',
    options: [...options, { flag: '--help', description: 'Display help', takesValue: false }],
    words: [
      ...subcommands.map((subcommand) => subcommand.name),
      ...(argumentValues[command.name()] ?? []),
    ],
    subcommands,
  };
}

function collectValueCompletions(commands: readonly CompletionCommand[]): ValueCompletions {
  const flags = new Set(
    commands.flatMap((command) => [
      ...command.options,
      ...command.subcommands.flatMap((subcommand) => subcommand.options),
    ]),
  );
  const valueFlags = [...flags].filter((option) => option.takesValue).map((option) => option.flag);

  return {
    sourceFlags: valueFlags.includes('--source') ? ['--source'] : [],
    pathFlags: [...new Set(valueFlags.filter(isPathFlag))].sort(),
    sourceIds: getSupportedSourceIds(),
  };
}

function words(values: readonly string[]): string {
  return [...new Set(values)].join(' ');
}

/** A command's subcommands, argument values, and own options. */
function commandWords(command: CompletionCommand): string[] {
  return [...command.words, ...command.options.map((option) => option.flag)];
}

type CompletionCase = { key: string; words: string[] };

/**
 * One case per subcommand ("config init") before its parent ("config"), keyed by the
 * first one or two non-option words typed.
 */
function completionCases(commands: readonly CompletionCommand[]): CompletionCase[] {
  return commands.flatMap((command) => [
    ...command.subcommands.map((subcommand) => ({
      key: `${command.name} ${subcommand.name}`,
      words: commandWords(subcommand),
    })),
    { key: command.name, words: commandWords(command) },
  ]);
}

function rootWords(commands: readonly CompletionCommand[]): string {
  return words([...commands.map((command) => command.name), '--help', '--version']);
}

// Shell code shared by bash and zsh: the first two non-option words typed so far.
const COLLECT_COMMAND_KEY = `  local key="" word count=0
  for word in "$@"; do
    case "$word" in
      -*) ;;
      *) key="\${key:+$key }$word"; count=$((count + 1)); [ "$count" -eq 2 ] && break ;;
    esac
  done`;

function renderBash(commands: readonly CompletionCommand[], values: ValueCompletions): string {
  const cases = completionCases(commands)
    .map((entry) => `    "${entry.key}"|"${entry.key} "*) words="${words(entry.words)}" ;;`)
    .join('\n');

  return `# llm-usage bash completion. Load it with:
#   source <(llm-usage completion bash)
_llm_usage_key() {
${COLLECT_COMMAND_KEY}
  printf '%s' "$key"
}

_llm_usage() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local words

  # bash splits --flag=value at "=": complete the value of the flag before it.
  if [ "$cur" = "=" ]; then
    cur=""
  elif [ "$prev" = "=" ]; then
    prev="\${COMP_WORDS[COMP_CWORD-2]}"
  fi

  case "$prev" in
    ${values.sourceFlags.join('|') || '--source'}) COMPREPLY=($(compgen -W "${words(values.sourceIds)}" -- "$cur")); return ;;
    ${values.pathFlags.join('|') || '--repo-dir'}) COMPREPLY=($(compgen -f -- "$cur")); return ;;
  esac

  case "$(_llm_usage_key "\${COMP_WORDS[@]:1:COMP_CWORD-1}")" in
    "") words="${rootWords(commands)}" ;;
${cases}
    *) words="" ;;
  esac

  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
complete -F _llm_usage ${PROGRAM_NAMES.join(' ')}
`;
}

function renderZsh(commands: readonly CompletionCommand[], values: ValueCompletions): string {
  const cases = completionCases(commands)
    .map((entry) => `    "${entry.key}"|"${entry.key} "*) compadd -- ${words(entry.words)} ;;`)
    .join('\n');

  return `# llm-usage zsh completion. Load it with (after compinit):
#   source <(llm-usage completion zsh)
_llm_usage_key() {
${COLLECT_COMMAND_KEY}
  print -rn -- "$key"
}

_llm_usage() {
  local prev="\${words[CURRENT-1]}"

  case "$prev" in
    ${values.sourceFlags.join('|') || '--source'}) compadd -- ${words(values.sourceIds)}; return ;;
    ${values.pathFlags.join('|') || '--repo-dir'}) _files; return ;;
  esac

  case "$(_llm_usage_key "\${(@)words[2,CURRENT-1]}")" in
    "") compadd -- ${rootWords(commands)} ;;
${cases}
  esac
}
compdef _llm_usage ${PROGRAM_NAMES.join(' ')}
`;
}

function quoteFish(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function renderFishOption(
  command: CompletionCommand,
  option: CompletionOption,
  values: ValueCompletions,
): string {
  const parts = [
    'complete -c $cmd',
    `-n ${quoteFish(`__fish_seen_subcommand_from ${command.name}`)}`,
    `-l ${option.flag.slice(2)}`,
    `-d ${quoteFish(option.description)}`,
  ];

  if (values.sourceFlags.includes(option.flag)) {
    parts.push('-r', `-a ${quoteFish(words(values.sourceIds))}`);
  } else if (values.pathFlags.includes(option.flag)) {
    parts.push('-r', '-F');
  } else if (option.takesValue) {
    parts.push('-r');
  }

  return `    ${parts.join(' ')}`;
}

function renderFish(commands: readonly CompletionCommand[], values: ValueCompletions): string {
  const lines = commands.flatMap((command) => [
    `    complete -c $cmd -n __fish_use_subcommand -a ${command.name} -d ${quoteFish(command.description)}`,
    ...command.words.map(
      (word) =>
        `    complete -c $cmd -n ${quoteFish(`__fish_seen_subcommand_from ${command.name}`)} -a ${quoteFish(word)}`,
    ),
    ...command.options.map((option) => renderFishOption(command, option, values)),
    ...command.subcommands.flatMap((subcommand) =>
      subcommand.options.map((option) => renderFishOption(subcommand, option, values)),
    ),
  ]);

  return `# llm-usage fish completion. Install it with:
#   llm-usage completion fish > ~/.config/fish/completions/llm-usage.fish
for cmd in ${PROGRAM_NAMES.join(' ')}
    complete -c $cmd -f
${lines.join('\n')}
end
`;
}

/** A completion script for `shell`, generated from the live command tree. */
export function renderCompletionScript(
  program: Command,
  shell: CompletionShell,
  argumentValues: Readonly<Record<string, readonly string[]>>,
): string {
  const commands = program.commands.map((command) => describeCommand(command, argumentValues));
  const values = collectValueCompletions(commands);

  switch (shell) {
    case 'bash':
      return renderBash(commands, values);
    case 'zsh':
      return renderZsh(commands, values);
    case 'fish':
      return renderFish(commands, values);
  }
}

function parseShell(value: string): CompletionShell {
  const shell = COMPLETION_SHELLS.find((candidate) => candidate === value.trim().toLowerCase());

  if (!shell) {
    throw new Error(
      `Unsupported shell: ${value}. Expected one of: ${COMPLETION_SHELLS.join(', ')}`,
    );
  }

  return shell;
}

export function createCompletionCommand(
  getProgram: () => Command,
  argumentValues: Readonly<Record<string, readonly string[]>>,
): Command {
  return new Command('completion')
    .description('Print a shell completion script (bash, zsh, or fish)')
    .argument('<shell>', `Shell: ${COMPLETION_SHELLS.join(' | ')}`, parseShell)
    .addHelpText(
      'after',
      formatHelpExamples([
        'source <(llm-usage completion bash)   # in ~/.bashrc',
        'source <(llm-usage completion zsh)    # in ~/.zshrc',
        'llm-usage completion fish > ~/.config/fish/completions/llm-usage.fish',
      ]),
    )
    .action((shell: CompletionShell) => {
      process.stdout.write(renderCompletionScript(getProgram(), shell, argumentValues));
    });
}
