// In-memory sliding-window rate limiter — used for login, MFA
// verification, and request-access. Resets on a process restart; a
// documented, low-cost tradeoff for a self-hosted, single-instance
// service rather than adding a persistent store just for this.
const hits = new Map();

export function checkAndConsume(key, { max, windowMs }) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const timestamps = (hits.get(key) ?? []).filter((ts) => ts > cutoff);

  if (timestamps.length >= max) {
    hits.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  hits.set(key, timestamps);

  return true;
}

// Called opportunistically (e.g. from scripts/cleanup.mjs) so the map
// doesn't grow unboundedly across many distinct keys (IPs/usernames) over
// a long-running process's lifetime.
export function pruneExpired(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;

  for (const [key, timestamps] of hits) {
    const fresh = timestamps.filter((ts) => ts > cutoff);

    if (fresh.length === 0) {
      hits.delete(key);
    } else {
      hits.set(key, fresh);
    }
  }
}
