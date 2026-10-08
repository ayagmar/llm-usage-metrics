import { describe, expect, it } from 'vitest';

import {
  countActivityWeeks,
  escapeSvg,
  formatCompact,
  formatDecimal,
  formatInteger,
  formatUsd,
  getSourceColor,
  renderActivityGrid,
  renderShareCard,
  scaleY,
  shareThemes,
  svgText,
  truncateLabel,
} from '../../src/render/share-svg-theme.js';
import { expectShareCard, HOSTILE_TEXT } from './share-svg-assertions.js';

describe('share-svg-theme', () => {
  describe('getSourceColor', () => {
    it('returns known color for registered sources', () => {
      expect(getSourceColor('pi', 0)).toBe('#ec4899');
      expect(getSourceColor('codex', 1)).toBe('#22c55e');
      expect(getSourceColor('gemini', 2)).toBe('#eab308');
      expect(getSourceColor('droid', 3)).toBe('#3b82f6');
      expect(getSourceColor('opencode', 4)).toBe('#a855f7');
      expect(getSourceColor('claude', 5)).toBe('#d97757');
    });

    it('returns fallback color for unknown sources', () => {
      expect(getSourceColor('unknown', 0)).toBe('#f97316');
      expect(getSourceColor('custom', 1)).toBe('#06b6d4');
    });

    it('gives 16 distinct fallback colors and cycles after that', () => {
      const first16 = Array.from({ length: 16 }, (_, i) => getSourceColor(`s${i}`, i));
      expect(new Set(first16).size).toBe(16);
      expect(getSourceColor('wrap', 16)).toBe(getSourceColor('start', 0));
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

  describe('truncateLabel', () => {
    it('keeps short labels and cuts long ones with an ellipsis', () => {
      expect(truncateLabel('claude', 10)).toBe('claude');
      expect(truncateLabel('abcdefghij', 10)).toBe('abcdefghij');
      expect(truncateLabel('abcdefghijk', 10)).toBe('abcdefghi…');
    });

    it('never splits a grapheme', () => {
      const family = '👨‍👩‍👧';
      expect(truncateLabel(`${family}${family}${family}`, 2)).toBe(`${family}…`);
    });
  });

  describe('svgText', () => {
    it('escapes content and the suffix', () => {
      const text = svgText(10, 20, HOSTILE_TEXT, {
        size: 12,
        fill: '#000',
        suffix: { text: '<u>', size: 8, fill: '#111' },
      });

      expect(text).not.toContain('<script');
      expect(text).toContain('>&lt;u&gt;</tspan></text>');
    });
  });

  describe('renderShareCard', () => {
    it('frames the body at 1200x630 with the title, command, and footnote', () => {
      for (const theme of [shareThemes.dark, shareThemes.light]) {
        const svg = renderShareCard({
          theme,
          title: HOSTILE_TEXT,
          subtitle: 'Sub',
          command: 'llm-usage daily --share',
          footnote: '2026-01-01 to 2026-01-31',
          body: '<g/>',
        });

        expectShareCard(svg, theme);
        expect(svg).toContain('$ llm-usage daily --share');
        expect(svg).toContain('2026-01-01 to 2026-01-31');
      }
    });
  });

  describe('renderActivityGrid', () => {
    const days = ['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-31', '2026-02-02'].map(
      (date) => ({ date, totalTokens: 1, level: 2 as const }),
    );

    it('puts each day in its Monday-first row and week column', () => {
      // A contiguous Thursday-to-Monday run: Thursday is row 3, Monday opens column 1.
      const run = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'].map(
        (date) => ({ date, totalTokens: 1, level: 1 as const }),
      );
      const grid = renderActivityGrid({
        theme: shareThemes.dark,
        days: run,
        x: 100,
        y: 50,
        pitch: 20,
      });

      expect(grid).toContain('data-date="2026-01-01" data-level="1" x="100" y="110"');
      expect(grid).toContain('data-date="2026-01-04" data-level="1" x="100" y="170"');
      expect(grid).toContain('data-date="2026-01-05" data-level="1" x="120" y="50"');
      expect(countActivityWeeks(run)).toBe(2);
    });

    it('labels the first column and each month that has room', () => {
      const grid = renderActivityGrid({
        theme: shareThemes.dark,
        days: days.slice(0, 1),
        x: 100,
        y: 50,
        pitch: 20,
      });

      expect(grid).toContain('>Jan<');
      expect(renderActivityGrid({ theme: shareThemes.dark, days: [], x: 0, y: 0, pitch: 20 })).toBe(
        '',
      );
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
