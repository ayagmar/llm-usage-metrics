const intFmt = new Intl.NumberFormat('en-US');

/** `1 file`, `2 files`, `1,250 events`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${intFmt.format(count)} ${count === 1 ? singular : plural}`;
}
