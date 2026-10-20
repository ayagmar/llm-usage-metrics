/** A `fetch` for fetchers that must stay offline: any call fails the test. */
export const noNetworkFetch: typeof fetch = () =>
  Promise.reject(new Error('this test makes no network calls'));
