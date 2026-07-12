// Tiny zero-dependency in-memory rate limiter (fixed-window per key).
// Good enough for a single-process personal deployment; if you ever run
// multiple instances, swap this for a shared store (Redis) based limiter.

/**
 * @param {object} opts
 * @param {number} opts.windowMs  window size in milliseconds
 * @param {number} opts.max       max requests per key per window
 * @param {(req) => string} [opts.key]  key extractor (default: client IP)
 */
export function rateLimit({ windowMs, max, key }) {
  const hits = new Map(); // key -> { count, resetAt }

  // Periodically drop expired entries so the map can't grow unbounded.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of hits) if (now > e.resetAt) hits.delete(k);
  }, windowMs);
  timer.unref?.(); // don't keep the process alive just for cleanup

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const k = key ? key(req) : (req.ip || req.socket?.remoteAddress || 'unknown');
    let e = hits.get(k);
    if (!e || now > e.resetAt) {
      e = { count: 0, resetAt: now + windowMs };
      hits.set(k, e);
    }
    e.count++;
    const remaining = Math.max(0, max - e.count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    if (e.count > max) {
      const retry = Math.ceil((e.resetAt - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: '请求过于频繁,请稍后再试' });
    }
    next();
  };
}
