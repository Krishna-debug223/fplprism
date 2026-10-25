const FPL_BASE = "https://fantasy.premierleague.com/api";
const DEFAULT_TIMEOUT_MS = 8_000;
const cache = new Map<string, { expiresAt: number; promise: Promise<unknown> }>();

export async function fplFetch<T>(path: string, revalidate = 300, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const fetchFresh = async () => {
    const response = await fetch(`${FPL_BASE}${path}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "FPL-Prism/0.5 (independent public beta)",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) throw new Error(`FPL API returned ${response.status}`);
    return response.json();
  };

  if (revalidate <= 0) return fetchFresh() as Promise<T>;

  const now = Date.now();
  // The same FPL path is requested with different freshness requirements.
  // Keep their caches separate so a five-minute page cache cannot satisfy a
  // one-minute pre-kickoff refresh with stale player availability.
  const cacheKey = `${path}:${revalidate}`;
  const current = cache.get(cacheKey);
  if (current && current.expiresAt > now) return current.promise as Promise<T>;

  const promise = fetchFresh();
  cache.set(cacheKey, { expiresAt: now + revalidate * 1_000, promise });
  promise.catch(() => {
    if (cache.get(cacheKey)?.promise === promise) cache.delete(cacheKey);
  });
  return promise as Promise<T>;
}
