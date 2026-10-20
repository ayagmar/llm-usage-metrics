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

// Words that start a code span without naming a command: metric values and other programs.
const NON_COMMAND_WORDS = new Set(['active-hours', 'tokens', 'npm', 'npx']);

// Spans that invoke the CLI: `llm-usage <command> ...`, or a bare `<command> ...` as the
// command table and the prose write them. A bare lowercase first word counts as a command
// even when the CLI does not know it, so a renamed command is reported instead of skipped.
function commandReferences(markdown: string): CommandReference[] {
  return codeSpans(markdown).flatMap((span) => {
    const words = span.split(/\s+/u);
    if (words[0] === 'llm-usage') {
      return [{ span, words: words.slice(1) }];
    }
    const first = words[0] ?? '';
    return /^[a-z][a-z-]*$/u.test(first) && !NON_COMMAND_WORDS.has(first) ? [{ span, words }] : [];
  });
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

// Problems in one span: an unknown command or subcommand, a flag the command does not take,
// or a value outside the flag's choices.
function referenceProblems(root: Command, { span, words }: CommandReference): string[] {
  const { command, rest } = resolveCommand(root, words);
  const next = rest[0] ?? '';
  if (command.commands.length > 0 && /^[a-z][a-z-]*$/u.test(next)) {
    return [`${span}: unknown command ${next}`];
  }

  return rest.flatMap((word, index) => {
    if (!word.startsWith('--')) {
      return [];
    }
    const [flag, ...inlineValue] = word.split('=');
    if (flag === '--help') {
      return [];
    }
    const option = command.options.find((candidate) => candidate.long === flag);
    if (!option) {
      return [`${span}: ${flag}`];
    }
    const value = inlineValue.length > 0 ? inlineValue.join('=') : (rest.at(index + 1) ?? '');
    const choices = option.argChoices;
    return choices && !value.startsWith('<') && !choices.includes(value)
      ? [`${span}: ${flag} ${value}`]
      : [];
  });
}

describe('agent skill', () => {
  const markdown = readFileSync(skillPath, 'utf8');
  const cli = createCli();

  it('keeps the frontmatter name equal to the skill directory name', () => {
    expect(markdown).toMatch(/^---\nname: llm-usage-metrics\n/u);
  });

  it('fails when a command, flag, or flag value the skill tells agents to use is renamed or removed', () => {
    const references = commandReferences(markdown);
    expect(references.length).toBeGreaterThan(40);

    expect(references.flatMap((reference) => referenceProblems(cli, reference))).toEqual([]);
  });

  it('fails when a flag the skill names on its own no longer exists on any command', () => {
    const flags = new Set(allLongFlags(cli));
    const unknown = codeSpans(markdown)
      .filter((span) => span.startsWith('--'))
      .map((span) => span.split(/[\s=]/u)[0])
      .filter((flag) => !flags.has(flag));

    expect(unknown).toEqual([]);
  });
});
