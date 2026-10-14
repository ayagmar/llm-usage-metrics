import { CommanderError, type Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createCli } from '../../src/cli/create-cli.js';
import { useIsolatedEnvironment } from '../helpers/isolated-env.js';
import {
  COMMAND_NAMES,
  expectGolden,
  helpGoldenName,
  useGoldenUpdateCheck,
  WINDOWS_SKIP_REASON,
} from './golden-harness.js';

/** Fixed width for help text; commander otherwise reads the terminal's. */
const HELP_COLUMNS = 100;

function captureOutput(command: Command, chunks: string[]): void {
  command.configureOutput({
    writeOut: (text) => chunks.push(text),
    writeErr: (text) => chunks.push(text),
    getOutHelpWidth: () => HELP_COLUMNS,
    getErrHelpWidth: () => HELP_COLUMNS,
    getOutHasColors: () => false,
    getErrHasColors: () => false,
  });
  command.exitOverride();

  // addCommand does not copy output settings to subcommands.
  for (const subcommand of command.commands) {
    captureOutput(subcommand, chunks);
  }
}

async function captureHelp(args: string[]): Promise<string> {
  const program = createCli({ version: '0.0.0-golden' });
  const chunks: string[] = [];
  captureOutput(program, chunks);

  try {
    await program.parseAsync(['node', 'llm-usage', ...args, '--help']);
  } catch (error) {
    if (!(error instanceof CommanderError) || error.code !== 'commander.helpDisplayed') {
      throw error;
    }
  }

  return chunks.join('');
}

// Skipped on Windows: paths and newline handling differ there; the Linux leg guards behaviour.
describe.skipIf(process.platform === 'win32')(`help goldens (${WINDOWS_SKIP_REASON})`, () => {
  useIsolatedEnvironment();
  useGoldenUpdateCheck();

  it('freezes help/root.txt', async () => {
    const help = await captureHelp([]);

    expect(help).toContain('Usage: llm-usage');
    await expectGolden(helpGoldenName(undefined), help);
  });

  for (const name of COMMAND_NAMES) {
    it(`freezes ${helpGoldenName(name)}`, async () => {
      const help = await captureHelp([name]);

      expect(help).toContain(`Usage: llm-usage ${name}`);
      await expectGolden(helpGoldenName(name), help);
    });
  }
});
