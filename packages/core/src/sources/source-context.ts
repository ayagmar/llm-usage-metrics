import os from 'node:os';

/** A problem an adapter reports through `SourceContext.onDiagnostic` instead of throwing. */
export type SourceDiagnostic = {
  source: string;
  level: 'warn' | 'info';
  message: string;
  path?: string;
};

/** What an adapter may read from its host: home directory, environment and platform. */
export type SourceContext = {
  homeDir: string;
  /** Held by reference (process.env by default), so adapters see later env changes. */
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Receives non-fatal problems; without it they are dropped. */
  onDiagnostic?: (diagnostic: SourceDiagnostic) => void;
};

/** Fills unset fields from the host at call time; never call it at module level. */
export function createSourceContext(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    homeDir: overrides.homeDir ?? os.homedir(),
    env: overrides.env ?? process.env,
    platform: overrides.platform ?? process.platform,
    onDiagnostic: overrides.onDiagnostic,
  };
}

/** An environment variable holding a path: trimmed, and undefined when empty. */
export function readEnvPath(context: SourceContext, name: string): string | undefined {
  const value = context.env[name];

  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}
