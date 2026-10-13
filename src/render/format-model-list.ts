/** The first `limit` model names, then `+N more` for the rest. */
export function limitNamedModels(models: readonly string[], limit: number): string[] {
  if (models.length <= limit) {
    return [...models];
  }

  return [...models.slice(0, limit), `+${models.length - limit} more`];
}
