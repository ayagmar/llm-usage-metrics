export function parseBooleanToken(envValue: string | undefined): boolean | undefined {
  if (envValue === undefined) {
    return undefined;
  }

  const normalizedValue = envValue.trim().toLowerCase();

  if (normalizedValue.length === 0) {
    return undefined;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalizedValue)) {
    return false;
  }

  return undefined;
}

export function isTruthyEnvFlag(value: string | undefined): boolean {
  return parseBooleanToken(value) === true;
}
