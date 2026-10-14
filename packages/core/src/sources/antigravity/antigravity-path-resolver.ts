import path from 'node:path';

import { readEnvPath, type SourceContext } from '../source-context.js';

function resolveGeminiCliHome(context: SourceContext): string {
  return readEnvPath(context, 'GEMINI_CLI_HOME') ?? path.join(context.homeDir, '.gemini');
}

export function getDefaultAntigravityConversationsDir(context: SourceContext): string {
  return path.join(resolveGeminiCliHome(context), 'antigravity-cli', 'conversations');
}
