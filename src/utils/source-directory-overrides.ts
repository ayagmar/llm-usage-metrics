export function parseSourceDirectoryOverrides(entries: string[] | undefined): Map<string, string> {
  const overrides = new Map<string, string>();

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

    if (overrides.has(sourceId)) {
      throw new Error(`Duplicate --source-dir source id: ${sourceId}`);
    }

    overrides.set(sourceId, directoryPath);
  }

  return overrides;
}
