export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
  readonly retryAfterMs?: number;
}

export interface ApiRateLimiter {
  consume(key: string): RateLimitDecision;
}

export interface FixedWindowRateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly clock?: () => number;
}

interface WindowState {
  startedAt: number;
  count: number;
}

/**
 * Small in-process limiter for local composition and deterministic tests.
 * Hosted deployments should replace this port with a shared limiter.
 */
export class FixedWindowRateLimiter implements ApiRateLimiter {
  private readonly windows = new Map<string, WindowState>();
  private readonly clock: () => number;

  constructor(private readonly options: FixedWindowRateLimiterOptions) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new Error('Rate-limit limit must be a positive integer');
    }
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
      throw new Error('Rate-limit windowMs must be a positive integer');
    }
    this.clock = options.clock ?? (() => Date.now());
  }

  consume(key: string): RateLimitDecision {
    const now = this.clock();
    const current = this.windows.get(key);
    const state =
      current === undefined || now >= current.startedAt + this.options.windowMs
        ? { startedAt: now, count: 0 }
        : current;
    state.count += 1;
    this.windows.set(key, state);
    const allowed = state.count <= this.options.limit;
    return {
      allowed,
      limit: this.options.limit,
      remaining: Math.max(0, this.options.limit - state.count),
      resetAt: state.startedAt + this.options.windowMs,
      retryAfterMs: Math.max(0, state.startedAt + this.options.windowMs - now),
    };
  }
}
