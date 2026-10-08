import { describe, expect, it, vi } from 'vitest';

import { warnIfTerminalTableOverflows } from '../../src/cli/terminal-overflow-warning.js';

describe('warnIfTerminalTableOverflows', () => {
  it('does not warn when stdout is not a tty', () => {
    const warnSpy = vi.fn();

    warnIfTerminalTableOverflows('│ A │ B │', warnSpy, { isTTY: false, columns: 5 });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn when output has no table-like lines', () => {
    const warnSpy = vi.fn();

    warnIfTerminalTableOverflows('plain output', warnSpy, { isTTY: true, columns: 5 });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('measures only table lines, so a long plain line next to a fitting table does not warn', () => {
    const warnSpy = vi.fn();

    warnIfTerminalTableOverflows(`${'x'.repeat(50)}\n│ A │`, warnSpy, { isTTY: true, columns: 10 });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn when table width fits terminal columns', () => {
    const warnSpy = vi.fn();

    warnIfTerminalTableOverflows('│ A │', warnSpy, { isTTY: true, columns: 5 });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when table width exceeds terminal columns', () => {
    const warnSpy = vi.fn();

    warnIfTerminalTableOverflows('│ Period │ Source │', warnSpy, { isTTY: true, columns: 10 });

    expect(warnSpy).toHaveBeenCalledWith(
      'Report table is wider than terminal by 9 column(s). Use fullscreen/maximized terminal for better readability.',
    );
  });
});
