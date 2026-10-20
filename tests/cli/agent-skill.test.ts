import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createCli } from '../../src/cli/create-cli.js';

const skillPath = path.resolve('skills/llm-usage-metrics/SKILL.md');

type CommandReference = { span: string; words: string[] };

// Inline code spans, plus each line of a fenced code block.
function codeSpans(markdown: string): string[] {
  const spans: string[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
    } else if (inFence) {
      spans.push(line.trim().replace(/^\$\s+/u, ''));
    } else {
      spans.push(...[...line.matchAll(/`([^`]+)`/gu)].map((match) => match[1]));
    }
  }
  return spans;
}

function longFlags(command: Command): string[] {
  return command.options.flatMap((option) => (option.long ? [option.long] : []));
}

function allLongFlags(command: Command): string[] {
  return [...longFlags(command), ...command.commands.flatMap(allLongFlags)];
}

// Spans that invoke the CLI: `llm-usage <command> ...`, or a bare `<command> ...` whose first
// word names a top-level command, as the command table and the prose write them.
function commandReferences(markdown: string, commandNames: Set<string>): CommandReference[] {
  return codeSpans(markdown).flatMap((span) => {
    const words = span.split(/\s+/u);
    if (words[0] === 'llm-usage') {
      return [{ span, words: words.slice(1) }];
    }
    return commandNames.has(words[0] ?? '') ? [{ span, words }] : [];
  });
}

// The second cell of each row of the "Pick the command" table must start with a command.
function tableCommandCells(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Question'))
    .filter((line) => !line.startsWith('| -'))
    .map((line) => line.split('|')[2]?.trim() ?? '')
    .filter((cell) => cell.length > 0);
}

function resolveCommand(root: Command, words: string[]): { command: Command; rest: string[] } {
  let command = root;
  let index = 0;
  for (; index < words.length; index += 1) {
    const subcommand = command.commands.find((candidate) => candidate.name() === words[index]);
    if (!subcommand) {
      break;
    }
    command = subcommand;
  }
  return { command, rest: words.slice(index) };
}

describe('agent skill', () => {
  const markdown = readFileSync(skillPath, 'utf8');
  const cli = createCli();
  const commandNames = new Set(cli.commands.map((command) => command.name()));

  it('keeps the frontmatter name equal to the skill directory name', () => {
    expect(markdown).toMatch(/^---\nname: llm-usage-metrics\n/u);
  });

  it('fails when a command the skill tells agents to run is renamed or removed', () => {
    const cells = tableCommandCells(markdown);
    expect(cells.length).toBeGreaterThan(10);

    const unknown = cells.filter((cell) => {
      const firstWord = (codeSpans(cell)[0] ?? '').split(/\s+/u)[0] ?? '';
      return !commandNames.has(firstWord) && firstWord !== 'llm-usage';
    });

    expect(unknown).toEqual([]);
  });

  it('fails when a flag the skill passes to a command is renamed or removed from that command', () => {
    const references = commandReferences(markdown, commandNames);
    expect(references.length).toBeGreaterThan(20);

    const unknown = references.flatMap(({ span, words }) => {
      const { command, rest } = resolveCommand(cli, words);
      const flags = new Set([...longFlags(command), '--help']);
      return rest
        .filter((word) => word.startsWith('--'))
        .filter((flag) => !flags.has(flag.split('=')[0] ?? flag))
        .map((flag) => `${span}: ${flag}`);
    });

    expect(unknown).toEqual([]);
  });

  it('fails when a flag the skill names on its own no longer exists on any command', () => {
    const flags = new Set(allLongFlags(cli));
    const unknown = codeSpans(markdown)
      .filter((span) => span.startsWith('--'))
      .map((span) => span.split(/\s+/u)[0] ?? span)
      .filter((flag) => !flags.has(flag));

    expect(unknown).toEqual([]);
  });
});
