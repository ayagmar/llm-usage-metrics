export function compareByCodePoint(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();

  for (;;) {
    const leftStep = leftIterator.next();
    const rightStep = rightIterator.next();

    if (leftStep.done && rightStep.done) {
      return 0;
    }

    if (leftStep.done) {
      return -1;
    }

    if (rightStep.done) {
      return 1;
    }

    const leftCodePoint = leftStep.value.codePointAt(0) ?? 0;
    const rightCodePoint = rightStep.value.codePointAt(0) ?? 0;

    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1;
    }
  }
}
