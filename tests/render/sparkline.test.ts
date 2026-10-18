import { describe, expect, it } from 'vitest';

import { downsamplePeaks, renderSparkline, sparklineLevel } from '../../src/render/sparkline.js';

describe('sparkline', () => {
  it('draws one glyph per value, scaled to the largest', () => {
    expect(renderSparkline([0, 1, 2, 3, 4, 5, 6, 7, 8], 20)).toBe(' ▁▂▃▄▅▆▇█');
  });

  it('keeps a light day visible next to a heavy one', () => {
    expect(renderSparkline([1, 10_000], 10)).toBe('▁█');
  });

  it('is blank when nothing was used', () => {
    expect(renderSparkline([0, 0, 0], 10)).toBe('   ');
    expect(renderSparkline([], 10)).toBe('');
  });

  it('keeps a one-day spike when a long series is squeezed into fewer columns', () => {
    const values = Array.from({ length: 365 }, (_, index) => (index === 200 ? 50 : 1));
    const sparkline = renderSparkline(values, 40);

    expect(sparkline).toHaveLength(40);
    expect(sparkline.split('█')).toHaveLength(2);
  });

  it('downsamples to each column’s peak and leaves short series alone', () => {
    expect(downsamplePeaks([1, 5, 2, 0, 3, 4], 3)).toEqual([5, 2, 4]);
    expect(downsamplePeaks([1, 2], 5)).toEqual([1, 2]);
  });

  it('scales levels to a taller chart', () => {
    expect(sparklineLevel(50, 100, 32)).toBe(16);
    expect(sparklineLevel(0.1, 100, 32)).toBe(1);
    expect(sparklineLevel(100, 0)).toBe(0);
  });
});
