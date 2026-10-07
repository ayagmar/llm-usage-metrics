/** Optimal string alignment distance: edits plus adjacent transpositions ("dialy"). */
function editDistance(left: string, right: string): number {
  const rows: number[][] = Array.from({ length: left.length + 1 }, (_, leftIndex) =>
    Array.from({ length: right.length + 1 }, (_, rightIndex) =>
      leftIndex === 0 ? rightIndex : rightIndex === 0 ? leftIndex : 0,
    ),
  );

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      let distance = Math.min(
        rows[leftIndex - 1][rightIndex] + 1,
        rows[leftIndex][rightIndex - 1] + 1,
        rows[leftIndex - 1][rightIndex - 1] + substitutionCost,
      );

      if (
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        distance = Math.min(distance, rows[leftIndex - 2][rightIndex - 2] + 1);
      }

      rows[leftIndex][rightIndex] = distance;
    }
  }

  return rows[left.length][right.length];
}

/**
 * The candidate closest to `input` by edit distance, if it is close enough to be a
 * likely typo: at most a third of the input's length, and never more than 3 edits.
 * Ties keep the earlier candidate, so callers control the order.
 */
export function suggestClosest(input: string, candidates: readonly string[]): string | undefined {
  const normalizedInput = input.trim().toLowerCase();
  const maxDistance = Math.min(3, Math.max(1, Math.floor(normalizedInput.length / 3)));
  let bestCandidate: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = editDistance(normalizedInput, candidate.toLowerCase());

    if (distance <= maxDistance && distance < bestDistance) {
      bestCandidate = candidate;
      bestDistance = distance;
    }
  }

  return bestCandidate;
}
