export function formatByteSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
}
