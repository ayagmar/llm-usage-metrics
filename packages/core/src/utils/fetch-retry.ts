/** A response whose HTTP status is worth another attempt. */
export class RetryableFetchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RetryableFetchError';
  }
}

export function isRetryableHttpStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

export function isRetryableFetchFailure(error: unknown): boolean {
  if (error instanceof RetryableFetchError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return true;
  }

  if (error instanceof TypeError) {
    return true;
  }

  return /timeout|timed out|network|econn|enotfound|eai_again/iu.test(error.message);
}
