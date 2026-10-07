/** A dedicated directory flag or config value: one path, or several when repeated. */
export type SourceDirectoryValue = string | readonly string[];

export function toSourceDirectoryList(value: SourceDirectoryValue | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return typeof value === 'string' ? [value] : [...value];
}

/** Parses repeated `--source-dir <source-id>=<path>` entries; a source may repeat. */
export function parseSourceDirectoryOverrides(
  entries: readonly string[] | undefined,
): Map<string, string[]> {
  const overrides = new Map<string, string[]>();

  if (!entries || entries.length === 0) {
    return overrides;
  }

  for (const entry of entries) {
    const separatorIndex = entry.indexOf('=');

    if (separatorIndex <= 0 || separatorIndex >= entry.length - 1) {
      throw new Error('--source-dir must use format <source-id>=<path>');
    }

    const sourceId = entry.slice(0, separatorIndex).trim().toLowerCase();
    const directoryPath = entry.slice(separatorIndex + 1).trim();

    if (!sourceId || !directoryPath) {
      throw new Error('--source-dir must use non-empty <source-id>=<path> values');
    }

    const directories = overrides.get(sourceId) ?? [];

    if (!directories.includes(directoryPath)) {
      directories.push(directoryPath);
    }

    overrides.set(sourceId, directories);
  }

  return overrides;
}
