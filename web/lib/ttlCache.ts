/**
 * Small in-memory caches for the API routes. They live in the server
 * instance's memory, so they are best effort: a cold start or a second
 * instance starts empty. That is enough to stop every CDN miss and every
 * status poll from spending a GitHub API call.
 */

type Clock = () => number;

interface Entry<V> {
  /** Pending loads never expire; the TTL starts once the value arrives. */
  expires: number;
  value: Promise<V>;
}

export interface TtlCache<K, V> {
  /**
   * Return the cached value for `key`, or run `load` and cache its result.
   * Concurrent callers share one pending load. `fresh` skips the cached value
   * and stores the new result for everyone else. A rejected load is dropped.
   */
  get(key: K, load: () => Promise<V>, options?: { fresh?: boolean }): Promise<V>;
  clear(): void;
}

export function createTtlCache<K, V>(
  ttlMs: number | ((value: V) => number),
  now: Clock = Date.now,
): TtlCache<K, V> {
  const entries = new Map<K, Entry<V>>();
  const ttlFor = typeof ttlMs === "function" ? ttlMs : () => ttlMs;

  return {
    get(key, load, options = {}) {
      const existing = entries.get(key);
      if (!options.fresh && existing && existing.expires > now()) return existing.value;

      const entry = { expires: Number.POSITIVE_INFINITY } as Entry<V>;
      entry.value = load().then(
        (value) => {
          if (entries.get(key) === entry) entry.expires = now() + ttlFor(value);
          return value;
        },
        (error: unknown) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        },
      );
      entries.set(key, entry);
      return entry.value;
    },
    clear() {
      entries.clear();
    },
  };
}

export interface KeyedLock {
  /** Take the lock for `key` unless someone else holds it and it has not expired. */
  tryAcquire(key: string): boolean;
  release(key: string): void;
}

/** A per-key lock that frees itself after `ttlMs`, so a lost release cannot wedge it. */
export function createKeyedLock(ttlMs: number, now: Clock = Date.now): KeyedLock {
  const held = new Map<string, number>();
  return {
    tryAcquire(key) {
      const until = held.get(key);
      if (until !== undefined && until > now()) return false;
      held.set(key, now() + ttlMs);
      return true;
    },
    release(key) {
      held.delete(key);
    },
  };
}
