/** Highest cost first, a known cost before an unknown one; 0 leaves the order to a tie-break. */
export function compareCostDescending(
  left: { costUsd?: number },
  right: { costUsd?: number },
): number {
  if (left.costUsd !== undefined && right.costUsd === undefined) {
    return -1;
  }

  if (left.costUsd === undefined && right.costUsd !== undefined) {
    return 1;
  }

  if (left.costUsd !== undefined && right.costUsd !== undefined && left.costUsd !== right.costUsd) {
    return right.costUsd - left.costUsd;
  }

  return 0;
}
