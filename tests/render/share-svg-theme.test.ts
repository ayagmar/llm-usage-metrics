import { describe, expect, it } from 'vitest';

import {
  catmullRom,
  escapeSvg,
  formatCompact,
  formatDecimal,
  formatInteger,
  formatUsd,
  getSourceColor,
  scaleY,
} from '../../src/render/share-svg-theme.js';

describe('share-svg-theme', () => {
  describe('getSourceColor', () => {
    it('returns known color for registered sources', () => {
      expect(getSourceColor('pi', 0)).toBe('#ec4899');
      expect(getSourceColor('codex', 1)).toBe('#22c55e');
      expect(getSourceColor('gemini', 2)).toBe('#eab308');
      expect(getSourceColor('droid', 3)).toBe('#3b82f6');
      expect(getSourceColor('opencode', 4)).toBe('#a855f7');
    });

    it('returns fallback color for unknown sources', () => {
      expect(getSourceColor('unknown', 0)).toBe('#f97316');
      expect(getSourceColor('custom', 1)).toBe('#06b6d4');
    });

    it('cycles fallback colors by index', () => {
      const color0 = getSourceColor('x', 0);
      const color5 = getSourceColor('y', 5);
      expect(color0).toBe(color5);
    });
  });

  describe('escapeSvg', () => {
    it('escapes all XML special characters', () => {
      expect(escapeSvg('a & b < c > d " e \' f')).toBe('a &amp; b &lt; c &gt; d &quot; e &#39; f');
    });

    it('returns plain text unchanged', () => {
      expect(escapeSvg('hello')).toBe('hello');
    });
  });

  describe('formatCompact', () => {
    it('formats billions', () => {
      expect(formatCompact(13_600_000_000)).toBe('13.6B');
    });

    it('formats millions', () => {
      expect(formatCompact(3_800_000)).toBe('3.8M');
    });

    it('formats thousands', () => {
      expect(formatCompact(71_800)).toBe('71.8k');
    });

    it('formats small numbers as-is', () => {
      expect(formatCompact(999)).toBe('999');
      expect(formatCompact(0)).toBe('0');
    });

    it('drops trailing .0', () => {
      expect(formatCompact(1_000_000_000)).toBe('1B');
      expect(formatCompact(2_000_000)).toBe('2M');
    });
  });

  describe('formatInteger', () => {
    it('formats with commas', () => {
      expect(formatInteger(1234567)).toBe('1,234,567');
    });
  });

  describe('formatDecimal', () => {
    it('formats with 2 decimal places', () => {
      expect(formatDecimal(491.67)).toBe('491.67');
    });

    it('returns dash for undefined', () => {
      expect(formatDecimal(undefined)).toBe('-');
    });
  });

  describe('formatUsd', () => {
    it('formats as currency', () => {
      expect(formatUsd(13)).toBe('$13.00');
    });

    it('returns dash for undefined', () => {
      expect(formatUsd(undefined)).toBe('-');
    });
  });

  describe('catmullRom', () => {
    it('returns empty string for fewer than 2 points', () => {
      expect(catmullRom([])).toBe('');
      expect(catmullRom([{ x: 0, y: 0 }])).toBe('');
    });

    it('generates a path string for 2+ points', () => {
      const path = catmullRom([
        { x: 0, y: 100 },
        { x: 50, y: 50 },
        { x: 100, y: 80 },
      ]);

      expect(path).toMatch(/^M0\.00,100\.00/);
      expect(path).toContain('C');
    });

    it('clamps control points to yFloor', () => {
      const path = catmullRom(
        [
          { x: 0, y: 0 },
          { x: 50, y: 100 },
        ],
        0.3,
        100,
      );

      const yValues = path.match(/[\d.]+/g)?.map(Number) ?? [];
      for (let i = 1; i < yValues.length; i += 2) {
        expect(yValues[i]).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('scaleY', () => {
    it('maps 0 to bottom', () => {
      expect(scaleY(0, 100, 10, 110)).toBe(110);
    });

    it('maps max to top', () => {
      expect(scaleY(100, 100, 10, 110)).toBe(10);
    });

    it('returns bottom when max is 0', () => {
      expect(scaleY(50, 0, 10, 110)).toBe(110);
    });
  });
});
