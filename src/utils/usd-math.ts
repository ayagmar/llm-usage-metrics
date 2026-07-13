// Fixed-point at 1e-12 USD so repeated addition never drifts.
const USD_PRECISION_SCALE = 1_000_000_000_000;

export function addUsd(left: number, right: number): number {
  return Math.round((left + right) * USD_PRECISION_SCALE) / USD_PRECISION_SCALE;
}

export function roundUsd(value: number): number {
  return Math.round(value * USD_PRECISION_SCALE) / USD_PRECISION_SCALE;
}
