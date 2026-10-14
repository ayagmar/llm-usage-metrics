/** A dedicated directory flag or config value: one path, or several when repeated. */
export type SourceDirectoryValue = string | readonly string[];

export function toSourceDirectoryList(value: SourceDirectoryValue | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return typeof value === 'string' ? [value] : [...value];
}
