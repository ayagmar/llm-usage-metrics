export type ActiveConfigEntry = {
  key: string;
  value: string;
};

export type ActiveConfig = {
  path: string;
  entries: ActiveConfigEntry[];
};

export function formatActiveConfig(activeConfig: ActiveConfig | undefined): string[] {
  if (!activeConfig || activeConfig.entries.length === 0) {
    return [];
  }

  const lines: string[] = [];
  lines.push(`Active config: ${activeConfig.path}`);

  for (const { key, value } of activeConfig.entries) {
    lines.push(`  ${key}=${value}`);
  }

  return lines;
}
