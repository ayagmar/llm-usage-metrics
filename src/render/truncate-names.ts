/** The first `limit` names (models, sources, machines), then `+N more` for the rest. */
export function truncateNames(names: readonly string[], limit: number): string[] {
  if (names.length <= limit) {
    return [...names];
  }

  return [...names.slice(0, limit), `+${names.length - limit} more`];
}
