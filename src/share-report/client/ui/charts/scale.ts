// Scales: values to pixels. Pure arithmetic; every chart draws through these.

export type LinearScale = {
  /** The top of the domain: a tick value, at least the largest value drawn. */
  max: number;
  ticks: number[];
  /** A value's pixel position: 0 at `range[0]`, `max` at `range[1]`. */
  at: (value: number) => number;
};

const NICE_STEPS = [1, 2, 2.5, 5, 10];

/**
 * A round step that splits `max` into at most `count` parts: 1, 2, 2.5 or 5 times a power of
 * ten. `max` must be positive.
 */
export function niceStep(max: number, count: number): number {
  const raw = max / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = NICE_STEPS.find((candidate) => candidate * power >= raw) ?? 10;

  return step * power;
}

/**
 * A scale from 0 to a round maximum over a pixel range (bottom to top for a y axis), with its
 * ticks. An empty or all-zero domain still draws one step, so the axis never collapses.
 */
export function linearScale(
  maxValue: number,
  range: readonly [number, number],
  tickCount = 4,
): LinearScale {
  const positive = Number.isFinite(maxValue) && maxValue > 0 ? maxValue : 0;
  const step = positive > 0 ? niceStep(positive, tickCount) : 1;
  const steps = Math.max(1, Math.ceil(positive / step - 1e-9));
  const max = step * steps;
  // Ticks are rebuilt from integers so 0.1 + 0.2 never shows as 0.30000000000000004.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const ticks = Array.from({ length: steps + 1 }, (_, index) =>
    Number((index * step).toFixed(decimals)),
  );
  const [start, end] = range;

  return { max, ticks, at: (value) => start + ((end - start) * value) / max };
}

export type BandScale = {
  /** The width of one slot. */
  step: number;
  /** The drawn width inside a slot, after the gap. */
  bandwidth: number;
  /** The left edge of a slot's band. */
  at: (index: number) => number;
};

/**
 * `count` equal slots over a pixel range; each band leaves a gap of `gapRatio` of its slot,
 * dropped when a slot is too thin for a gap to show, and is centred in its slot at most
 * `maxBandwidth` wide, so a few periods do not draw as slabs.
 */
export function bandScale(
  count: number,
  range: readonly [number, number],
  gapRatio = 0.2,
  maxBandwidth = Number.POSITIVE_INFINITY,
): BandScale {
  const [start, end] = range;
  const step = (end - start) / Math.max(1, count);
  const gap = step >= 4 ? Math.min(step * gapRatio, 12) : 0;
  const bandwidth = Math.min(step - gap, maxBandwidth);

  return { step, bandwidth, at: (index) => start + index * step + (step - bandwidth) / 2 };
}

/** The heat level 0–4 of a value against the largest: 0 only for no usage. */
export function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) {
    return 0;
  }

  return Math.min(4, Math.max(1, Math.ceil((4 * value) / max)));
}
