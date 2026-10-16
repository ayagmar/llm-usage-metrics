import { describe, expect, it } from 'vitest';

import { wrapCaption } from '../../../../src/share-report/client/ui/charts/frame.js';
import {
  estimateTextWidth,
  fitText,
  layoutLegend,
  pickTickSlots,
  placeAxisLabels,
} from '../../../../src/share-report/client/ui/charts/layout.js';
import { dotSlots, linePath } from '../../../../src/share-report/client/ui/charts/rates.js';
import {
  bandScale,
  heatLevel,
  linearScale,
  niceStep,
} from '../../../../src/share-report/client/ui/charts/scale.js';

describe('linear scale', () => {
  it('rounds the top up to a tick that covers the largest value', () => {
    for (const max of [0.36, 1, 7, 26_800, 31_100, 611_000_000, 9_795.54, 0.004]) {
      const scale = linearScale(max, [200, 0]);
      const step = scale.ticks[1] - scale.ticks[0];

      expect(scale.max).toBeGreaterThanOrEqual(max);
      expect(scale.max - max).toBeLessThan(step + 1e-12);
      expect(scale.ticks[0]).toBe(0);
      expect(scale.ticks.at(-1)).toBeCloseTo(scale.max, 12);
      expect(scale.ticks.length).toBeLessThanOrEqual(5);
    }
  });

  it('writes ticks without float noise', () => {
    expect(linearScale(0.36, [100, 0]).ticks).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(linearScale(0.7, [100, 0]).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
  });

  it('keeps one step for an empty or all-zero domain instead of dividing by zero', () => {
    for (const max of [0, -1, Number.NaN]) {
      const scale = linearScale(max, [100, 0]);

      expect(scale.ticks).toEqual([0, 1]);
      expect(scale.at(0)).toBe(100);
      expect(Number.isFinite(scale.at(1))).toBe(true);
    }
  });

  it('maps 0 to the start of the range and the top to its end', () => {
    const scale = linearScale(26_800, [230, 30]);

    expect(scale.at(0)).toBe(230);
    expect(scale.at(scale.max)).toBe(30);
  });

  it('steps in 1, 2, 2.5 or 5 times a power of ten', () => {
    expect(niceStep(31_100, 4)).toBe(10_000);
    expect(niceStep(0.36, 4)).toBe(0.1);
    expect(niceStep(9.5, 4)).toBe(2.5);
    expect(niceStep(1, 4)).toBe(0.25);
  });
});

describe('band scale', () => {
  it('splits the range into equal slots with a gap inside each', () => {
    const band = bandScale(4, [0, 400]);

    expect(band.step).toBe(100);
    expect(band.bandwidth).toBe(88);
    expect(band.at(0)).toBe(6);
    expect(band.at(3) + band.bandwidth).toBe(394);
  });

  it('drops the gap when slots are too thin for one to show', () => {
    const band = bandScale(2000, [0, 1000]);

    expect(band.bandwidth).toBe(band.step);
  });

  it('caps a band and centres it, so a week of days does not draw slabs', () => {
    const band = bandScale(7, [0, 1260], 0.2, 64);

    expect(band.bandwidth).toBe(64);
    expect(band.at(0) + band.bandwidth / 2).toBe(90);
  });
});

describe('heat level', () => {
  it('is 0 only without usage and 4 at the peak', () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(5, 0)).toBe(0);
    expect(heatLevel(0.001, 100)).toBe(1);
    expect(heatLevel(25, 100)).toBe(1);
    expect(heatLevel(26, 100)).toBe(2);
    expect(heatLevel(75, 100)).toBe(3);
    expect(heatLevel(100, 100)).toBe(4);
  });
});

describe('label layout', () => {
  it('shortens text with an ellipsis to fit, and leaves fitting text alone', () => {
    expect(fitText('alpha', 12, 200)).toBe('alpha');

    const cut = fitText('project-with-a-longish-name-12', 12, 80);
    expect(cut.endsWith('…')).toBe(true);
    expect(estimateTextWidth(cut, 12)).toBeLessThanOrEqual(80);
    expect(fitText('anything', 12, 5)).toBe('');
  });

  it('thins axis labels so neighbours never overlap', () => {
    const labels = Array.from({ length: 300 }, (_, index) => `${index + 1} Oct`);

    for (const slotWidth of [2, 4.2, 9, 30, 120]) {
      const slots = pickTickSlots(labels, slotWidth, 11);
      const widest = Math.max(...labels.map((label) => estimateTextWidth(label, 11)));

      expect(slots[0]).toBe(0);
      for (const [index, slot] of slots.slice(1).entries()) {
        expect((slot - slots[index]) * slotWidth).toBeGreaterThanOrEqual(widest);
      }
    }

    expect(pickTickSlots([], 10, 11)).toEqual([]);
  });

  it('keeps placed axis labels inside the plot and apart', () => {
    const labels = Array.from({ length: 30 }, (_, index) => `${index + 1} Jan`);
    const slots = pickTickSlots(labels, 10, 11);
    const placed = placeAxisLabels(
      labels,
      slots,
      (slot) => 40 + slot * 10 + 5,
      { left: 40, right: 340 },
      11,
    );

    expect(placed.length).toBeGreaterThan(1);
    let previousRight = Number.NEGATIVE_INFINITY;

    for (const { slot, x } of placed) {
      const half = estimateTextWidth(labels[slot], 11) / 2;
      expect(x - half).toBeGreaterThanOrEqual(40);
      expect(x + half).toBeLessThanOrEqual(340);
      expect(x - half).toBeGreaterThanOrEqual(previousRight);
      previousRight = x + half;
    }
  });

  it('wraps legend entries into rows that fit the width', () => {
    const items = Array.from({ length: 9 }, (_, index) => ({
      label: index === 4 ? 'x'.repeat(200) : `project-${index}`,
      value: '$1.23K',
    }));

    for (const width of [280, 640, 1200]) {
      const layout = layoutLegend(items, width, { size: 12, swatch: 10, gap: 16 });

      expect(layout.items).toHaveLength(items.length);
      for (const item of layout.items) {
        expect(item.x + 16 + estimateTextWidth(item.text, 12)).toBeLessThanOrEqual(width + 0.01);
        expect(item.text.endsWith('$1.23K')).toBe(true);
      }
      expect(layout.rows).toBe(Math.max(...layout.items.map((item) => item.row)) + 1);
    }

    expect(layoutLegend([], 300, { size: 12, swatch: 10, gap: 16 }).rows).toBe(0);
  });

  it('wraps a caption between its parts', () => {
    const caption =
      'Cost (both) by source, per day · 1 Jan 2026 – 26 Oct 2026 · $9,795.54 in total';

    expect(wrapCaption(caption, 2000)).toEqual([caption]);
    expect(wrapCaption(caption, 330)).toEqual([
      'Cost (both) by source, per day',
      '1 Jan 2026 – 26 Oct 2026',
      '$9,795.54 in total',
    ]);
    for (const line of wrapCaption(caption, 120)) {
      expect(estimateTextWidth(line, 12)).toBeLessThanOrEqual(120);
    }
  });
});

describe('line path', () => {
  const at = (x: number, y: number) => ({ x, y });

  it('draws through consecutive points and breaks at a missing one', () => {
    expect(linePath([at(0, 10), at(10, 20), null, at(30, 5), at(40, 6.123)])).toBe(
      'M0 10L10 20M30 5L40 6.12',
    );
  });

  it('draws nothing for a point with no neighbour, which gets a dot instead', () => {
    expect(linePath([null, at(10, 20), null])).toBe('');
    expect(linePath([])).toBe('');
    expect(dotSlots([null, 0.5, null, 0.2, 0.3], 2)).toEqual([1]);
  });

  it('dots every point when the slots are wide enough', () => {
    expect(dotSlots([0.1, null, 0.2, 0.3], 40)).toEqual([0, 2, 3]);
  });
});
