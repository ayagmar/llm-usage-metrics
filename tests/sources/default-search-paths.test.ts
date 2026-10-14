import type * as NodeOs from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultAdapters } from '../../src/sources/create-default-adapters.js';
import { createSourceContext } from '../../src/sources/source-context.js';

const HOME_DIR = '/home/tester';

// The host (home dir, platform, env) is set to values unlike the injected context, so
// these paths only come out when every adapter reads the context and not the host.
const { HOST_HOME_DIR } = vi.hoisted(() => ({ HOST_HOME_DIR: '/host/elsewhere' }));
const HOST_PLATFORM: NodeJS.Platform = 'aix';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  const homedir = () => HOST_HOME_DIR;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const OVERRIDE_VARIABLES = {
  APPDATA: '/env/appdata',
  CLAUDE_CONFIG_DIR: '/env/claude-a,/env/claude-b',
  CODEX_HOME: '/env/codex-home',
  COPILOT_OTEL_FILE_EXPORTER_PATH: '/env/copilot/otel.jsonl',
  DSH_HOME: '/env/dsh-home',
  GEMINI_CLI_HOME: '/env/gemini-home',
  GOOSE_PATH_ROOT: '/env/goose-root',
  LOCALAPPDATA: '/env/localappdata',
  USERPROFILE: '/env/userprofile',
  XDG_DATA_HOME: '/env/xdg-data',
} as const;

const PLATFORMS = ['linux', 'darwin', 'win32'] as const;

type Platform = (typeof PLATFORMS)[number];
type OverrideVariable = keyof typeof OVERRIDE_VARIABLES;
type SearchPaths = Record<string, readonly string[] | undefined>;
type EnvCase = 'no overrides' | 'all overrides' | 'whitespace overrides';

function envFor(envCase: EnvCase): NodeJS.ProcessEnv {
  const names = Object.keys(OVERRIDE_VARIABLES) as OverrideVariable[];

  switch (envCase) {
    case 'no overrides':
      return {};
    case 'all overrides':
      return { ...OVERRIDE_VARIABLES };
    case 'whitespace overrides':
      return Object.fromEntries(names.map((name) => [name, ' \t ']));
  }
}

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.unstubAllEnvs();
});

function getDefaultSearchPaths(platform: Platform, envCase: EnvCase): SearchPaths {
  const env = envFor(envCase);

  Object.defineProperty(process, 'platform', { value: HOST_PLATFORM });
  for (const name of Object.keys(OVERRIDE_VARIABLES)) {
    vi.stubEnv(name, `/host/${name.toLowerCase()}`);
  }

  const context = createSourceContext({ homeDir: HOME_DIR, env, platform });

  return Object.fromEntries(
    createDefaultAdapters({}, context).map((adapter) => [adapter.id, adapter.getSearchPaths?.()]),
  );
}

const EXPECTED: Record<Platform, Record<'noOverrides' | 'allOverrides', SearchPaths>> = {
  linux: {
    noOverrides: {
      pi: ['/home/tester/.pi/agent/sessions', '/home/tester/.omp/agent/sessions'],
      codex: ['/home/tester/.codex/sessions'],
      gemini: ['/home/tester/.gemini'],
      droid: ['/home/tester/.factory/sessions'],
      opencode: [
        '/home/tester/.local/share/opencode/opencode.db',
        '/home/tester/.local/share/opencode/db.sqlite',
        '/home/tester/.opencode/opencode.db',
        '/home/tester/.opencode/db.sqlite',
      ],
      openclaw: [
        '/home/tester/.openclaw/agents',
        '/home/tester/.clawdbot/agents',
        '/home/tester/.moltbot/agents',
        '/home/tester/.moldbot/agents',
      ],
      claude: ['/home/tester/.claude/projects', '/home/tester/.claude/transcripts'],
      copilot: ['/home/tester/.copilot/otel'],
      goose: [
        '/home/tester/.local/share/goose/sessions/sessions.db',
        '/home/tester/.local/share/Block/goose/sessions/sessions.db',
      ],
      amp: ['/home/tester/.local/share/amp/threads'],
      qwen: ['/home/tester/.qwen/projects'],
      kimi: ['/home/tester/.kimi/sessions', '/home/tester/.kimi-code/sessions'],
      cline: [
        '/home/tester/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks',
      ],
      roocode: [
        '/home/tester/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
      ],
      kilocode: [
        '/home/tester/.config/Code/User/globalStorage/kilocode.kilo-code/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks',
      ],
      antigravity: ['/home/tester/.gemini/antigravity-cli/conversations'],
      dsh: ['/home/tester/.dsh/sessions'],
    },
    allOverrides: {
      pi: ['/home/tester/.pi/agent/sessions', '/home/tester/.omp/agent/sessions'],
      codex: ['/env/codex-home/sessions'],
      gemini: ['/env/gemini-home'],
      droid: ['/home/tester/.factory/sessions'],
      opencode: [
        '/env/xdg-data/opencode/opencode.db',
        '/env/xdg-data/opencode/db.sqlite',
        '/home/tester/.opencode/opencode.db',
        '/home/tester/.opencode/db.sqlite',
      ],
      openclaw: [
        '/home/tester/.openclaw/agents',
        '/home/tester/.clawdbot/agents',
        '/home/tester/.moltbot/agents',
        '/home/tester/.moldbot/agents',
      ],
      claude: [
        '/env/claude-a/projects',
        '/env/claude-a/transcripts',
        '/env/claude-b/projects',
        '/env/claude-b/transcripts',
      ],
      copilot: ['/home/tester/.copilot/otel'],
      goose: [
        '/env/goose-root/data/sessions/sessions.db',
        '/env/xdg-data/goose/sessions/sessions.db',
        '/home/tester/.local/share/Block/goose/sessions/sessions.db',
      ],
      amp: ['/env/xdg-data/amp/threads'],
      qwen: ['/home/tester/.qwen/projects'],
      kimi: ['/home/tester/.kimi/sessions', '/home/tester/.kimi-code/sessions'],
      cline: [
        '/home/tester/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks',
      ],
      roocode: [
        '/home/tester/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
      ],
      kilocode: [
        '/home/tester/.config/Code/User/globalStorage/kilocode.kilo-code/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks',
      ],
      antigravity: ['/env/gemini-home/antigravity-cli/conversations'],
      dsh: ['/env/dsh-home/sessions'],
    },
  },
  darwin: {
    noOverrides: {
      pi: ['/home/tester/.pi/agent/sessions', '/home/tester/.omp/agent/sessions'],
      codex: ['/home/tester/.codex/sessions'],
      gemini: ['/home/tester/.gemini'],
      droid: ['/home/tester/.factory/sessions'],
      opencode: [
        '/home/tester/Library/Application Support/opencode/opencode.db',
        '/home/tester/Library/Application Support/opencode/db.sqlite',
        '/home/tester/.opencode/opencode.db',
        '/home/tester/.opencode/db.sqlite',
      ],
      openclaw: [
        '/home/tester/.openclaw/agents',
        '/home/tester/.clawdbot/agents',
        '/home/tester/.moltbot/agents',
        '/home/tester/.moldbot/agents',
      ],
      claude: ['/home/tester/.claude/projects', '/home/tester/.claude/transcripts'],
      copilot: ['/home/tester/.copilot/otel'],
      goose: [
        '/home/tester/Library/Application Support/goose/sessions/sessions.db',
        '/home/tester/.local/share/Block/goose/sessions/sessions.db',
      ],
      amp: ['/home/tester/.local/share/amp/threads'],
      qwen: ['/home/tester/.qwen/projects'],
      kimi: ['/home/tester/.kimi/sessions', '/home/tester/.kimi-code/sessions'],
      cline: [
        '/home/tester/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks',
      ],
      roocode: [
        '/home/tester/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
      ],
      kilocode: [
        '/home/tester/Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks',
      ],
      antigravity: ['/home/tester/.gemini/antigravity-cli/conversations'],
      dsh: ['/home/tester/.dsh/sessions'],
    },
    allOverrides: {
      pi: ['/home/tester/.pi/agent/sessions', '/home/tester/.omp/agent/sessions'],
      codex: ['/env/codex-home/sessions'],
      gemini: ['/env/gemini-home'],
      droid: ['/home/tester/.factory/sessions'],
      opencode: [
        '/home/tester/Library/Application Support/opencode/opencode.db',
        '/home/tester/Library/Application Support/opencode/db.sqlite',
        '/home/tester/.opencode/opencode.db',
        '/home/tester/.opencode/db.sqlite',
      ],
      openclaw: [
        '/home/tester/.openclaw/agents',
        '/home/tester/.clawdbot/agents',
        '/home/tester/.moltbot/agents',
        '/home/tester/.moldbot/agents',
      ],
      claude: [
        '/env/claude-a/projects',
        '/env/claude-a/transcripts',
        '/env/claude-b/projects',
        '/env/claude-b/transcripts',
      ],
      copilot: ['/home/tester/.copilot/otel'],
      goose: [
        '/env/goose-root/data/sessions/sessions.db',
        '/home/tester/Library/Application Support/goose/sessions/sessions.db',
        '/home/tester/.local/share/Block/goose/sessions/sessions.db',
      ],
      amp: ['/env/xdg-data/amp/threads'],
      qwen: ['/home/tester/.qwen/projects'],
      kimi: ['/home/tester/.kimi/sessions', '/home/tester/.kimi-code/sessions'],
      cline: [
        '/home/tester/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks',
      ],
      roocode: [
        '/home/tester/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
      ],
      kilocode: [
        '/home/tester/Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks',
      ],
      antigravity: ['/env/gemini-home/antigravity-cli/conversations'],
      dsh: ['/env/dsh-home/sessions'],
    },
  },
  win32: {
    noOverrides: {
      pi: ['/home/tester/.pi/agent/sessions', '/home/tester/.omp/agent/sessions'],
      codex: ['/home/tester/.codex/sessions'],
      gemini: ['/home/tester/.gemini'],
      droid: ['/home/tester/.factory/sessions'],
      opencode: ['/home/tester/.opencode/opencode.db', '/home/tester/.opencode/db.sqlite'],
      openclaw: [
        '/home/tester/.openclaw/agents',
        '/home/tester/.clawdbot/agents',
        '/home/tester/.moltbot/agents',
        '/home/tester/.moldbot/agents',
      ],
      claude: ['/home/tester/.claude/projects', '/home/tester/.claude/transcripts'],
      copilot: ['/home/tester/.copilot/otel'],
      goose: ['/home/tester/.local/share/Block/goose/sessions/sessions.db'],
      amp: ['/home/tester/.local/share/amp/threads'],
      qwen: ['/home/tester/.qwen/projects'],
      kimi: ['/home/tester/.kimi/sessions', '/home/tester/.kimi-code/sessions'],
      cline: [
        '/home/tester/AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks',
      ],
      roocode: [
        '/home/tester/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
      ],
      kilocode: [
        '/home/tester/AppData/Roaming/Code/User/globalStorage/kilocode.kilo-code/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks',
      ],
      antigravity: ['/home/tester/.gemini/antigravity-cli/conversations'],
      dsh: ['/home/tester/.dsh/sessions'],
    },
    allOverrides: {
      pi: ['/home/tester/.pi/agent/sessions', '/home/tester/.omp/agent/sessions'],
      codex: ['/env/codex-home/sessions'],
      gemini: ['/env/gemini-home'],
      droid: ['/home/tester/.factory/sessions'],
      opencode: [
        '/env/appdata/opencode/opencode.db',
        '/env/appdata/opencode/db.sqlite',
        '/home/tester/.opencode/opencode.db',
        '/home/tester/.opencode/db.sqlite',
      ],
      openclaw: [
        '/home/tester/.openclaw/agents',
        '/home/tester/.clawdbot/agents',
        '/home/tester/.moltbot/agents',
        '/home/tester/.moldbot/agents',
      ],
      claude: [
        '/env/claude-a/projects',
        '/env/claude-a/transcripts',
        '/env/claude-b/projects',
        '/env/claude-b/transcripts',
      ],
      copilot: ['/home/tester/.copilot/otel'],
      goose: [
        '/env/goose-root/data/sessions/sessions.db',
        '/env/appdata/goose/sessions/sessions.db',
        '/home/tester/.local/share/Block/goose/sessions/sessions.db',
      ],
      amp: ['/env/xdg-data/amp/threads'],
      qwen: ['/home/tester/.qwen/projects'],
      kimi: ['/home/tester/.kimi/sessions', '/home/tester/.kimi-code/sessions'],
      cline: [
        '/env/appdata/Code/User/globalStorage/saoudrizwan.claude-dev/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks',
      ],
      roocode: [
        '/env/appdata/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks',
      ],
      kilocode: [
        '/env/appdata/Code/User/globalStorage/kilocode.kilo-code/tasks',
        '/home/tester/.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks',
      ],
      antigravity: ['/env/gemini-home/antigravity-cli/conversations'],
      dsh: ['/env/dsh-home/sessions'],
    },
  },
};

// Inline expectations are POSIX paths, so a Windows host (backslash joins) skips this.
describe.skipIf(originalPlatform === 'win32')('default search paths', () => {
  for (const platform of PLATFORMS) {
    it(`${platform}, no override variables`, () => {
      expect(getDefaultSearchPaths(platform, 'no overrides')).toEqual(
        EXPECTED[platform].noOverrides,
      );
    });

    it(`${platform}, every override variable set`, () => {
      expect(getDefaultSearchPaths(platform, 'all overrides')).toEqual(
        EXPECTED[platform].allOverrides,
      );
    });

    it(`${platform}, whitespace-only overrides count as unset`, () => {
      expect(getDefaultSearchPaths(platform, 'whitespace overrides')).toEqual(
        EXPECTED[platform].noOverrides,
      );
    });
  }
});
