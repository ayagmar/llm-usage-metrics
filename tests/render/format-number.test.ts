import { describe, expect, it } from 'vitest';

import {
  formatApproxUsd,
  formatInteger,
  formatStatuslineCompact,
  formatUsd,
} from '../../src/render/format-number.js';

describe('format-number', () => {
  describe('formatStatuslineCompact', () => {
    it('formats billions', () => {
      expect(formatStatuslineCompact(13_600_000_000)).toBe('13.6B');
    });

    it('formats millions', () => {
      expect(formatStatuslineCompact(3_800_000)).toBe('3.8M');
    });

    it('formats thousands', () => {
      expect(formatStatuslineCompact(71_800)).toBe('71.8k');
    });

    it('formats small numbers as-is', () => {
      expect(formatStatuslineCompact(999)).toBe('999');
      expect(formatStatuslineCompact(0)).toBe('0');
    });

    it('drops trailing .0', () => {
      expect(formatStatuslineCompact(1_000_000_000)).toBe('1B');
      expect(formatStatuslineCompact(2_000_000)).toBe('2M');
    });
  });

  describe('formatInteger', () => {
    it('formats with commas', () => {
      expect(formatInteger(1234567)).toBe('1,234,567');
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

  describe('formatApproxUsd', () => {
    it('marks an incomplete cost as approximate', () => {
      expect(formatApproxUsd(1.5, true)).toBe('~$1.50');
      expect(formatApproxUsd(1.5, false)).toBe('$1.50');
    });

    it('never marks a missing cost', () => {
      expect(formatApproxUsd(undefined, true)).toBe('-');
    });
  });
});
