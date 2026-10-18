// Browser side of the state: the URL hash and the system colour scheme.

/** Writes the hash without a history entry per click; an empty hash leaves a clean URL. */
export function writeHash(hash: string): void {
  const url = `${location.pathname}${location.search}${hash === '' ? '' : `#${hash}`}`;

  try {
    history.replaceState(null, '', url);
  } catch {
    // Some browsers refuse history changes on file:// pages; the hash still works.
    location.replace(hash === '' ? '#' : `#${hash}`);
  }
}

export function readHash(): string {
  return location.hash.replace(/^#/u, '');
}

const darkScheme = (): MediaQueryList => matchMedia('(prefers-color-scheme: dark)');

export function systemPrefersDark(): boolean {
  return darkScheme().matches;
}

export function onSystemSchemeChange(listener: () => void): void {
  darkScheme().addEventListener('change', listener);
}
