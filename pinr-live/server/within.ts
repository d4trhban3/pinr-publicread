/**
 * A wait with a ceiling (DEBUG, 26 Oct: /api/candles for a curve coin with no file waited 10.3 s on GeckoTerminal's 10 s timeout). The answer is the promise's if it
 * comes within `ms`, else `fallback` at once; the promise itself is left to finish (it fills the cache for the next ask) and its failure is never unhandled.
 */
export async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  p.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, late]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** How long a visitor waits for GeckoTerminal's chart before the page says "not read yet" and asks again. */
export const CHART_WAIT_MS = 2500;
