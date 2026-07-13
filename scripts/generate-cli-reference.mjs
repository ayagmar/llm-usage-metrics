#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tsImport } from 'tsx/esm/api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const distEntrypoint = join(rootDir, 'dist', 'index.js');
const outputPath = join(rootDir, 'site', 'src', 'content', 'docs', 'cli-reference.mdx');

function appendScopeSuffix(description, suffix) {
  if (!suffix || description.endsWith(suffix)) {
    return description;
  }

  return `${description} ${suffix}`;
}

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    ...options,
  });

  return typeof output === 'string' ? output.trimEnd() : '';
}

function ensureDistBuild(options = {}) {
  const skipRebuild = options.skipRebuild ?? false;

  if (skipRebuild && existsSync(distEntrypoint)) {
    return;
  }

  console.log(
    skipRebuild
      ? 'dist/index.js not found. Building CLI...'
      : 'Rebuilding CLI dist before docs generation...',
  );
  run('pnpm', ['run', 'build'], { stdio: 'inherit' });
}

function normalizeDescription(text, optionLong, scopeSuffix) {
  const timezoneNormalizedText =
    optionLong === '--timezone'
      ? text.replace(/\(default:\s*"[^"]+"\)/g, '(default: local system timezone)')
      : text;

  const normalizedDescription =
    optionLong === '--share'
      ? 'Write a share SVG image to the current directory'
      : timezoneNormalizedText
          .replace(/\bmarkdown\b/giu, 'Markdown')
          .replace(/\s+/g, ' ')
          .trim();

  return appendScopeSuffix(normalizedDescription, scopeSuffix);
}

function parseOptions(helpText) {
  // A help text may concatenate several help blocks (a parent command plus
  // its subcommands), so every `Options:` section is scanned.
  const lines = helpText.split(/\r?\n/);
  const options = [];
  let inOptions = false;
  let current = null;

  for (const line of lines) {
    if (line.trim() === 'Options:') {
      inOptions = true;
      current = null;
      continue;
    }

    if (/^\s*[A-Z][a-z]+:/.test(line)) {
      inOptions = false;
      current = null;
      continue;
    }

    if (!inOptions || !line.trim()) {
      continue;
    }

    const match = line.match(/^\s*(?:(-\w),\s*)?(--[\w-]+)(?:\s+([^\s].*?))?\s{2,}(.+)$/);

    if (match) {
      const [, short, long, argPartRaw, description] = match;
      const argPart = argPartRaw?.trim() ?? '';

      current = {
        short: short ?? '',
        long,
        arg: argPart.startsWith('--') ? '' : argPart,
        description,
      };
      options.push(current);
      continue;
    }

    if (current) {
      current.description = `${current.description} ${line.trim()}`;
    }
  }

  const seenLongs = new Set();
  const dedupedOptions = [];

  for (const option of options) {
    if (seenLongs.has(option.long)) {
      continue;
    }

    seenLongs.add(option.long);
    dedupedOptions.push(option);
  }

  return dedupedOptions;
}

function sortOptions(options) {
  return [...options].sort((left, right) => {
    const leftTail = left.long === '--help' || left.long === '--version';
    const rightTail = right.long === '--help' || right.long === '--version';

    if (leftTail && !rightTail) {
      return 1;
    }
    if (!leftTail && rightTail) {
      return -1;
    }

    return left.long.localeCompare(right.long);
  });
}

function resolveScopeSuffix(optionLong, commandNames, commandMetas, reportMetas) {
  if (optionLong === '--help' || optionLong === '--version') {
    return '';
  }

  if (commandNames.size === 0 || commandNames.size === commandMetas.length) {
    return '';
  }

  const reportCommandNames = new Set(reportMetas.map((meta) => meta.commandName));
  const appliesToAllReportCommands = reportMetas.every((meta) =>
    commandNames.has(meta.commandName),
  );
  const appliesOnlyToReportCommands = [...commandNames].every((commandName) =>
    reportCommandNames.has(commandName),
  );

  if (appliesToAllReportCommands && appliesOnlyToReportCommands) {
    return '';
  }

  const matchingMetas = commandMetas.filter((meta) => commandNames.has(meta.commandName));

  if (matchingMetas.length === 0) {
    return '';
  }

  if (matchingMetas.every((meta) => meta.kind === 'usage-granularity')) {
    return '(usage reports only)';
  }

  if (matchingMetas.length === 1) {
    return `(${matchingMetas[0].commandName} only)`;
  }

  return `(${matchingMetas.map((meta) => meta.commandName).join(', ')} only)`;
}

function collectCommandOptionDescriptions(commandOptionsByCommand) {
  const descriptionsByOption = new Map();

  for (const [commandName, options] of Object.entries(commandOptionsByCommand)) {
    for (const option of options) {
      const descriptions = descriptionsByOption.get(option.long) ?? new Map();
      const normalizedDescription = option.description.replace(/\s+/g, ' ').trim();
      const commandNames = descriptions.get(normalizedDescription) ?? new Set();
      commandNames.add(commandName);
      descriptions.set(normalizedDescription, commandNames);
      descriptionsByOption.set(option.long, descriptions);
    }
  }

  return descriptionsByOption;
}

function formatCommandList(commandNames) {
  return [...commandNames].join(', ');
}

function resolveOptionDescription(option, commandOptionDescriptions) {
  const descriptions = commandOptionDescriptions.get(option.long);

  if (!descriptions || descriptions.size <= 1) {
    return {
      description: option.description,
      hasCommandSpecificDescriptions: false,
    };
  }

  return {
    description: [...descriptions]
      .map(([description, commandNames]) => `${formatCommandList(commandNames)}: ${description}`)
      .join('; '),
    hasCommandSpecificDescriptions: true,
  };
}

function deduplicateAndNormalizeOptions(
  rootOptions,
  commandOptionsByCommand,
  commandMetas,
  reportMetas,
) {
  const optionCommandMap = new Map();
  const commandOptionDescriptions = collectCommandOptionDescriptions(commandOptionsByCommand);

  for (const [commandName, options] of Object.entries(commandOptionsByCommand)) {
    for (const option of options) {
      const commandNames = optionCommandMap.get(option.long) ?? new Set();
      commandNames.add(commandName);
      optionCommandMap.set(option.long, commandNames);
    }
  }

  const byLong = new Map();

  for (const option of [...rootOptions, ...Object.values(commandOptionsByCommand).flat()]) {
    const { description, hasCommandSpecificDescriptions } = resolveOptionDescription(
      option,
      commandOptionDescriptions,
    );
    const scopeSuffix = hasCommandSpecificDescriptions
      ? ''
      : resolveScopeSuffix(
          option.long,
          optionCommandMap.get(option.long) ?? new Set(),
          commandMetas,
          reportMetas,
        );

    byLong.set(option.long, {
      ...option,
      description: normalizeDescription(description, option.long, scopeSuffix),
    });
  }

  return sortOptions([...byLong.values()]);
}

function generateMarkdown(version, commandMetas, options, examples, cellFormatters) {
  const { toMarkdownSafeCodeCell, toMarkdownSafeCell } = cellFormatters;
  const lines = [
    '---',
    'title: CLI Reference',
    'description: Command-line options and usage for llm-usage-metrics.',
    '---',
    '',
    ':::note[Auto-generated reference]',
    `Generated from CLI version \`${version}\` via \`scripts/generate-cli-reference.mjs\`.`,
    'For behavioral details and examples, see the other documentation pages.',
    ':::',
    '',
    '## Command structure',
    '',
    '```bash',
    'llm-usage <command> [options]',
    '```',
    '',
    'Commands:',
    '',
    ...commandMetas.map((meta) => `- \`${meta.docsLabel}\``),
    '',
    '## Options',
    '',
    'Generated from root + command help output.',
    '',
    '| Option | Short | Argument | Description |',
    '| --- | --- | --- | --- |',
  ];

  for (const option of options) {
    const long = toMarkdownSafeCodeCell(option.long);
    const short = option.short ? toMarkdownSafeCodeCell(option.short) : '-';
    const arg = option.arg ? toMarkdownSafeCodeCell(option.arg) : '-';
    const desc = toMarkdownSafeCell(option.description);

    lines.push(`| ${long} | ${short} | ${arg} | ${desc} |`);
  }

  lines.push('', '## Examples', '', '```bash', ...examples, '```');

  return `${lines.join('\n')}\n`;
}

function loadPackageVersion() {
  const packageJsonPath = join(rootDir, 'package.json');
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

  if (!parsed || typeof parsed.version !== 'string' || parsed.version.trim().length === 0) {
    throw new Error('package.json must contain a non-empty version');
  }

  return parsed.version.trim();
}

async function loadMarkdownCellFormatters() {
  const markdownSafeCellPath = join(rootDir, 'src', 'render', 'markdown-safe-cell.ts');
  const markdownSafeCellModule = await tsImport(markdownSafeCellPath, {
    parentURL: import.meta.url,
  });
  const toMarkdownSafeCodeCell = markdownSafeCellModule?.toMarkdownSafeCodeCell;
  const toMarkdownSafeCell = markdownSafeCellModule?.toMarkdownSafeCell;

  if (typeof toMarkdownSafeCodeCell !== 'function') {
    throw new Error(`Failed to load toMarkdownSafeCodeCell() from ${markdownSafeCellPath}`);
  }

  if (typeof toMarkdownSafeCell !== 'function') {
    throw new Error(`Failed to load toMarkdownSafeCell() from ${markdownSafeCellPath}`);
  }

  return {
    toMarkdownSafeCodeCell,
    toMarkdownSafeCell,
  };
}

async function loadCliMetadata() {
  const reportDefinitionsPath = join(
    rootDir,
    'src',
    'cli',
    'report-definitions',
    'report-definitions.ts',
  );
  const reportDefinitionsModule = await tsImport(reportDefinitionsPath, {
    parentURL: import.meta.url,
  });
  const getReportDefinitionMetas = reportDefinitionsModule?.getReportDefinitionMetas;
  const getCliReferenceExamples = reportDefinitionsModule?.getCliReferenceExamples;

  if (typeof getReportDefinitionMetas !== 'function') {
    throw new Error(`Failed to load getReportDefinitionMetas() from ${reportDefinitionsPath}`);
  }

  if (typeof getCliReferenceExamples !== 'function') {
    throw new Error(`Failed to load getCliReferenceExamples() from ${reportDefinitionsPath}`);
  }

  return {
    reportMetas: getReportDefinitionMetas(),
    examples: getCliReferenceExamples(),
  };
}

function createExtraCommandMeta(command) {
  const subcommandNames = command.commands.map((subcommand) => subcommand.name());

  return {
    commandName: command.name(),
    docsLabel:
      subcommandNames.length > 0
        ? `${command.name()} <${subcommandNames.join('|')}>`
        : command.name(),
    kind: 'specialized',
  };
}

function getCommandHelpText(cli, meta) {
  const subCommand = cli.commands.find((candidate) => candidate.name() === meta.commandName);

  if (!subCommand) {
    return '';
  }

  const subcommandHelps = subCommand.commands.map((candidate) => candidate.helpInformation());
  return [subCommand.helpInformation(), ...subcommandHelps].join('\n');
}

async function loadCliHelpTexts(version, reportMetas) {
  const cliModulePath = join(rootDir, 'src', 'cli', 'create-cli.ts');
  const cliModule = await tsImport(cliModulePath, { parentURL: import.meta.url });
  const createCli = cliModule?.createCli;

  if (typeof createCli !== 'function') {
    throw new Error(`Failed to load createCli() from ${cliModulePath}`);
  }

  const cli = createCli({ version });
  const rootHelp = cli.helpInformation();
  const reportCommandNames = new Set(reportMetas.map((meta) => meta.commandName));
  const extraCommandMetas = cli.commands
    .filter((command) => !reportCommandNames.has(command.name()))
    .map((command) => createExtraCommandMeta(command));
  const commandMetas = [...reportMetas, ...extraCommandMetas];
  const commandHelps = Object.fromEntries(
    commandMetas.map((meta) => {
      return [meta.commandName, getCommandHelpText(cli, meta)];
    }),
  );

  return { rootHelp, commandHelps, commandMetas };
}

async function main() {
  const skipRebuild = process.argv.includes('--no-rebuild');
  ensureDistBuild({ skipRebuild });

  const version = loadPackageVersion();
  const cellFormatters = await loadMarkdownCellFormatters();
  const { reportMetas, examples } = await loadCliMetadata();
  const helpTexts = await loadCliHelpTexts(version, reportMetas);
  const options = deduplicateAndNormalizeOptions(
    parseOptions(helpTexts.rootHelp),
    Object.fromEntries(
      Object.entries(helpTexts.commandHelps).map(([commandName, helpText]) => [
        commandName,
        parseOptions(helpText),
      ]),
    ),
    helpTexts.commandMetas,
    reportMetas,
  );
  const markdown = generateMarkdown(
    version,
    helpTexts.commandMetas,
    options,
    examples,
    cellFormatters,
  );

  writeFileSync(outputPath, markdown, 'utf8');
  console.log(`CLI reference generated at ${outputPath}`);
}

await main();
