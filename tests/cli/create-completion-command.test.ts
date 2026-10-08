import { describe, expect, it, vi } from 'vitest';

import { renderCompletionScript } from '../../src/cli/create-completion-command.js';
import { createCli } from '../../src/cli/create-cli.js';

const argumentValues = { efficiency: ['daily', 'weekly', 'monthly'], schema: ['summary', 'usage'] };

function render(shell: 'bash' | 'zsh' | 'fish'): string {
  return renderCompletionScript(createCli(), shell, argumentValues);
}

describe('renderCompletionScript', () => {
  it('completes every command, for both installed bin names', () => {
    const commandNames = createCli().commands.map((command) => command.name());

    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const script = render(shell);

      for (const name of commandNames) {
        expect(script, `${shell}: ${name}`).toContain(name);
      }

      expect(script).toContain('llm-usage-metrics');
    }

    expect(render('bash')).toContain('complete -F _llm_usage llm-usage llm-usage-metrics');
    expect(render('zsh')).toContain('compdef _llm_usage llm-usage llm-usage-metrics');
    expect(render('fish')).toContain('for cmd in llm-usage llm-usage-metrics');
  });

  it('completes the value of --flag=value in bash', () => {
    expect(render('bash')).toContain('if [ "$cur" = "=" ]; then');
    expect(render('bash')).toContain('prev="${COMP_WORDS[COMP_CWORD-2]}"');
  });

  it('keeps file completion off --source-dir, whose value is <source-id>=<path>', () => {
    const bash = render('bash');
    const pathCase =
      /\n {4}(--[^)]*)\) COMPREPLY=\(\$\(compgen -f/u.exec(bash)?.[1].split('|') ?? [];

    expect(pathCase).toContain('--claude-dir');
    expect(pathCase).not.toContain('--source-dir');
  });

  it('is written to be sourced in zsh, without an fpath #compdef header', () => {
    expect(render('zsh').startsWith('#compdef')).toBe(false);
    expect(render('zsh')).toContain('source <(llm-usage completion zsh)');
  });

  it('completes source ids after --source and files after path flags', () => {
    const bash = render('bash');

    const sourceWords = /--source\) COMPREPLY=\(\$\(compgen -W "([^"]*)"/u
      .exec(bash)?.[1]
      .split(' ');
    expect(sourceWords).toEqual(expect.arrayContaining(['claude', 'codex', 'pi']));
    expect(bash).toMatch(/[|(]--claude-dir[|)][^\n]*compgen -f/u);
    expect(render('zsh')).toMatch(/--repo-dir[|)][^\n]*_files/u);
    expect(render('fish')).toMatch(
      /__fish_seen_subcommand_from daily' -l claude-dir -d '[^']*' -r -F/u,
    );
  });

  it('offers argument values, subcommands, and subcommand options', () => {
    const bash = render('bash');

    expect(bash).toMatch(/"efficiency"\|"efficiency "\*\) words="daily weekly monthly /u);
    expect(bash).toMatch(/"schema"\|"schema "\*\) words="summary usage /u);
    // A subcommand's options belong to it, matched before its parent.
    expect(bash).toMatch(/"config init"\|"config init "\*\) words="--force --help"/u);
    expect(bash).toMatch(/"config"\|"config "\*\) words="init show path --help"/u);
    expect(bash.indexOf('"config init"')).toBeLessThan(bash.indexOf('"config"|'));
    expect(render('fish')).toMatch(/__fish_seen_subcommand_from init' -l force/u);
  });

  it('escapes quotes in fish descriptions', () => {
    const cli = createCli();
    cli.command('quote').description("it's here").option('--flag', "don't");

    const fish = renderCompletionScript(cli, 'fish', {});

    expect(fish).toContain("-a quote -d 'it\\'s here'");
    expect(fish).toContain("-l flag -d 'don\\'t'");
  });
});

describe('completion command', () => {
  it('prints the script for a shell and rejects unknown shells', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await createCli().parseAsync(['node', 'llm-usage', 'completion', 'fish']);
      expect(String(write.mock.calls[0]?.[0])).toContain('complete -c $cmd');
    } finally {
      write.mockRestore();
    }

    await expect(
      createCli().parseAsync(['node', 'llm-usage', 'completion', 'pwsh']),
    ).rejects.toThrow('Unsupported shell: pwsh. Expected one of: bash, zsh, fish');
  });
});
