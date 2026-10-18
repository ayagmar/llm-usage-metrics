import { compareByCodePoint } from '@ayagmar/agent-sessions/internal';

export type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

export function parseVersion(value: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
    value.trim(),
  );

  if (!match) {
    return undefined;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (![major, minor, patch].every((part) => Number.isSafeInteger(part))) {
    return undefined;
  }

  const prerelease = match[4] ? match[4].split('.') : [];

  return {
    major,
    minor,
    patch,
    prerelease,
  };
}

function isNumericIdentifier(value: string): boolean {
  return /^\d+$/u.test(value);
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftIsNumeric = isNumericIdentifier(left);
  const rightIsNumeric = isNumericIdentifier(right);

  if (leftIsNumeric && rightIsNumeric) {
    return Number(left) - Number(right);
  }

  if (leftIsNumeric && !rightIsNumeric) {
    return -1;
  }

  if (!leftIsNumeric && rightIsNumeric) {
    return 1;
  }

  return compareByCodePoint(left, right);
}

function isPrerelease(version: string): boolean {
  const parsed = parseVersion(version);
  return Boolean(parsed && parsed.prerelease.length > 0);
}

export function compareVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);

  if (!parsedLeft || !parsedRight) {
    return 0;
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }

  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }

  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch - parsedRight.patch;
  }

  const leftPrerelease = parsedLeft.prerelease;
  const rightPrerelease = parsedRight.prerelease;

  if (leftPrerelease.length === 0 && rightPrerelease.length === 0) {
    return 0;
  }

  if (leftPrerelease.length === 0) {
    return 1;
  }

  if (rightPrerelease.length === 0) {
    return -1;
  }

  const comparableLength = Math.min(leftPrerelease.length, rightPrerelease.length);

  for (let index = 0; index < comparableLength; index += 1) {
    const comparison = comparePrereleaseIdentifiers(leftPrerelease[index], rightPrerelease[index]);

    if (comparison !== 0) {
      return comparison;
    }
  }

  return leftPrerelease.length - rightPrerelease.length;
}

export function shouldOfferUpdate(currentVersion: string, latestVersion: string): boolean {
  if (isPrerelease(latestVersion) && !isPrerelease(currentVersion)) {
    return false;
  }

  return compareVersions(latestVersion, currentVersion) > 0;
}
