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
const commandReferences = [
  { label: 'daily', helpArgs: ['daily', '--help'] },
  { label: 'weekly', helpArgs: ['weekly', '--help'] },
  { label: 'monthly', helpArgs: ['monthly', '--help'] },
  { label: 'efficiency <daily|weekly|monthly>', helpArgs: ['efficiency', '--help'] },
  { label: 'optimize <daily|weekly|monthly>', helpArgs: ['optimize', '--help'] },
];
const efficiencyOnlyOptions = new Set(['--include-merge-commits', '--repo-dir']);
const usageOnlyOptions = new Set(['--per-model-columns']);
const optimizeOnlyOptions = new Set(['--candidate-model', '--top']);

function appendScopeSuffix(description, suffix) {
  return description.endsWith(suffix) ? description : `${description} ${suffix}`;
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

function normalizeDescription(text, optionLong) {
  const timezoneNormalizedText =
    optionLong === '--timezone'
      ? text.replace(/\(default:\s*"[^"]+"\)/g, '(default: local system timezone)')
      : text;

  const normalizedDescription =
    optionLong === '--share'
      ? 'Write a share SVG image to the current directory'
      : timezoneNormalizedText
          .replace(/\bmarkdown\b/giu, 'Markdown')
          .replace(/\s+\(efficiency only\)/gu, '')
          .replace(/\s+\(usage reports only\)/gu, '')
          .replace(/\s+\(optimize only\)/gu, '')
          .replace(/\s+/g, ' ')
          .trim();

  if (efficiencyOnlyOptions.has(optionLong)) {
    return appendScopeSuffix(normalizedDescription, '(efficiency only)');
  }

  if (usageOnlyOptions.has(optionLong)) {
    return appendScopeSuffix(normalizedDescription, '(usage reports only)');
  }

  if (optimizeOnlyOptions.has(optionLong)) {
    return appendScopeSuffix(normalizedDescription, '(optimize only)');
  }

  return normalizedDescription;
}

function parseOptions(helpText) {
  const lines = helpText.split(/\r?\n/);
  const options = [];

  const optionsStart = lines.findIndex((line) => line.trim() === 'Options:');
  if (optionsStart < 0) {
    return options;
  }

  let current = null;

  for (let index = optionsStart + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line.trim()) {
      continue;
    }

    if (/^\s*[A-Z][a-z]+:/.test(line)) {
      break;
    }

    const match = line.match(/^\s*(?:(-\w),\s*)?(--[\w-]+)(?:\s+([^\s].*?))?\s{2,}(.+)$/);

    if (match) {
      const [, short, long, argPartRaw, description] = match;
      const argPart = argPartRaw?.trim() ?? '';

      current = {
        short: short ?? '',
        long,
        arg: argPart.startsWith('--') ? '' : argPart,
        description: normalizeDescription(description, long),
      };
      options.push(current);
      continue;
    }

    if (current) {
      current.description = normalizeDescription(
        `${current.description} ${line.trim()}`,
        current.long,
      );
    }
  }

  return options;
}

function deduplicateOptions(options) {
  const byLong = new Map();
  for (const option of options) {
    byLong.set(option.long, option);
  }
  return [...byLong.values()];
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

function generateMarkdown(version, options) {
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
    ...commandReferences.map((command) => `- \`${command.label}\``),
    '',
    '## Options',
    '',
    'Generated from root + command help output.',
    '',
    '| Option | Short | Argument | Description |',
    '| --- | --- | --- | --- |',
  ];

  for (const option of options) {
    const short = option.short ? `\`${option.short}\`` : '-';
    const arg = option.arg ? `\`${option.arg.replace(/\|/g, '\\|')}\`` : '-';
    const desc = option.description.replace(/\|/g, '\\|');

    lines.push(`| \`${option.long}\` | ${short} | ${arg} | ${desc} |`);
  }

  lines.push(
    '',
    '## Examples',
    '',
    '```bash',
    'llm-usage daily',
    'llm-usage weekly --timezone Europe/Paris',
    'llm-usage monthly --since 2026-01-01 --until 2026-01-31',
    'llm-usage monthly --source gemini --gemini-dir /path/to/.gemini',
    'llm-usage monthly --source droid --droid-dir /path/to/.factory/sessions',
    'llm-usage monthly --source opencode --opencode-db /path/to/opencode.db',
    'llm-usage daily --source-dir pi=/tmp/pi-sessions --source-dir gemini=/tmp/.gemini --source-dir droid=/tmp/droid-sessions',
    'llm-usage daily --json',
    'llm-usage daily --markdown',
    'llm-usage monthly --share',
    'llm-usage efficiency weekly --repo-dir /path/to/repo --json',
    'llm-usage efficiency monthly --share',
    'llm-usage optimize monthly --provider openai --candidate-model gpt-4.1 --candidate-model gpt-5-codex --json',
    'llm-usage optimize monthly --provider openai --candidate-model gpt-4.1 --candidate-model gpt-5-codex --share',
    '```',
  );

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

async function loadCliHelpTexts(version) {
  const cliModulePath = join(rootDir, 'src', 'cli', 'create-cli.ts');
  const cliModule = await tsImport(cliModulePath, { parentURL: import.meta.url });
  const createCli = cliModule?.createCli;

  if (typeof createCli !== 'function') {
    throw new Error(`Failed to load createCli() from ${cliModulePath}`);
  }

  const cli = createCli({ version });
  const rootHelp = cli.helpInformation();
  const commandHelps = commandReferences.map((command) => {
    const commandName = command.helpArgs[0];
    const subCommand = cli.commands.find((candidate) => candidate.name() === commandName);
    return subCommand?.helpInformation() ?? '';
  });

  return { rootHelp, commandHelps };
}

function main() {
  const skipRebuild = process.argv.includes('--no-rebuild');
  ensureDistBuild({ skipRebuild });

  const version = loadPackageVersion();
  const options = sortOptions(
    deduplicateOptions(
      [
        parseOptions(main.helpTexts.rootHelp),
        ...main.helpTexts.commandHelps.map((helpText) => parseOptions(helpText)),
      ].flat(),
    ),
  );
  const markdown = generateMarkdown(version, options);

  writeFileSync(outputPath, markdown, 'utf8');
  console.log(`CLI reference generated at ${outputPath}`);
}

main.helpTexts = await loadCliHelpTexts(loadPackageVersion());
main();
