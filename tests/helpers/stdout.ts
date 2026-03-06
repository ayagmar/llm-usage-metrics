export function overrideStdoutProperty<Key extends 'isTTY' | 'columns'>(
  property: Key,
  value: NodeJS.WriteStream[Key],
): () => void {
  const stdout = process.stdout as NodeJS.WriteStream;
  const previousDescriptor = Object.getOwnPropertyDescriptor(stdout, property);

  Object.defineProperty(stdout, property, {
    configurable: true,
    value,
  });

  return () => {
    if (previousDescriptor) {
      Object.defineProperty(stdout, property, previousDescriptor);
      return;
    }

    Reflect.deleteProperty(stdout, property);
  };
}

export function overrideStdoutTty(columns: number): () => void {
  const restoreIsTTY = overrideStdoutProperty('isTTY', true);
  const restoreColumns = overrideStdoutProperty('columns', columns);

  return () => {
    restoreColumns();
    restoreIsTTY();
  };
}
