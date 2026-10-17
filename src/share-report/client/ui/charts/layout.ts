// Label layout without a DOM to measure in: widths are estimated from the character count at a
// generous average advance, so labels never collide even in a wide fallback font.

/** Average advance of a character in em; wide enough for the UI sans and the mono digits. */
const ADVANCE_EM = 0.62;

export function estimateTextWidth(content: string, size: number): number {
  return Array.from(content).length * size * ADVANCE_EM;
}

/** The text cut to fit `width` px with an ellipsis; empty when not even one character fits. */
export function fitText(content: string, size: number, width: number): string {
  if (estimateTextWidth(content, size) <= width) {
    return content;
  }

  const characters = Array.from(content);
  const fits = Math.floor(width / (size * ADVANCE_EM)) - 1;

  return fits < 1 ? '' : `${characters.slice(0, fits).join('').trimEnd()}…`;
}

/**
 * Which axis slots get a label: every `stride`-th from the first, with `stride` the smallest
 * that keeps the widest label plus a gap inside the slots it spans. The last slot is labelled
 * too when it does not crowd the one before.
 */
export function pickTickSlots(
  labels: readonly string[],
  slotWidth: number,
  size: number,
  gap = 8,
): number[] {
  if (labels.length === 0) {
    return [];
  }

  const widest = Math.max(...labels.map((label) => estimateTextWidth(label, size)));
  const stride = Math.max(1, Math.ceil((widest + gap) / Math.max(slotWidth, 1e-6)));
  const slots: number[] = [];

  for (let slot = 0; slot < labels.length; slot += stride) {
    slots.push(slot);
  }

  const last = labels.length - 1;

  if (slots.at(-1) !== last && last - (slots.at(-1) ?? 0) >= stride) {
    slots.push(last);
  }

  return slots;
}

/**
 * Where the picked axis labels go: centred on their slot, pulled inside `[left, right]` so the
 * ends never spill, and dropped when that pull would make one overlap the label before it.
 */
export function placeAxisLabels(
  labels: readonly string[],
  slots: readonly number[],
  centreOf: (slot: number) => number,
  bounds: { left: number; right: number },
  size: number,
  gap = 8,
): { slot: number; x: number }[] {
  const placed: { slot: number; x: number }[] = [];
  let previousRight = Number.NEGATIVE_INFINITY;

  for (const slot of slots) {
    const half = estimateTextWidth(labels[slot], size) / 2;
    const x = Math.min(Math.max(centreOf(slot), bounds.left + half), bounds.right - half);

    if (x - half >= previousRight + gap) {
      placed.push({ slot, x });
      previousRight = x + half;
    }
  }

  return placed;
}

export type LegendItem = { label: string; value: string };
export type PlacedLegendItem = LegendItem & { x: number; row: number; text: string };

/**
 * Legend entries in rows across `width`: each takes a swatch, its label and its value, and
 * wraps to a new row when it would overflow. A label longer than a whole row is shortened.
 */
export function layoutLegend(
  items: readonly LegendItem[],
  width: number,
  options: { size: number; swatch: number; gap: number },
): { items: PlacedLegendItem[]; rows: number } {
  const placed: PlacedLegendItem[] = [];
  const lead = options.swatch + 6;
  let x = 0;
  let row = 0;

  for (const item of items) {
    const suffix = item.value === '' ? '' : ` ${item.value}`;
    const room = width - lead - estimateTextWidth(suffix, options.size);
    const text = `${fitText(item.label, options.size, room)}${suffix}`;
    const itemWidth = lead + estimateTextWidth(text, options.size);

    if (x > 0 && x + itemWidth > width) {
      x = 0;
      row += 1;
    }

    placed.push({ ...item, x, row, text });
    x += itemWidth + options.gap;
  }

  return { items: placed, rows: items.length === 0 ? 0 : row + 1 };
}
