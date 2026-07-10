import os from 'node:os';
import path from 'node:path';

import { asTrimmedText } from '../parsing-utils.js';

export type AntigravityPathResolverOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

function resolveGeminiCliHome(options: Required<AntigravityPathResolverOptions>): string {
  return asTrimmedText(options.env.GEMINI_CLI_HOME) ?? path.join(options.homeDir, '.gemini');
}

export function getDefaultAntigravityConversationsDir(
  options: AntigravityPathResolverOptions = {},
): string {
  const resolvedOptions = {
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? os.homedir(),
  };

  return path.join(resolveGeminiCliHome(resolvedOptions), 'antigravity-cli', 'conversations');
}
