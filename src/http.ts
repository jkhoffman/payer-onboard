// Per-payer HTTP: a token bucket so one payer's limits are respected,
// and retries that honor Retry-After so a 429 slows us down instead of failing the run.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly clock: Clock;
  constructor(ratePerSec: number, burst: number, clock: Clock = realClock) {
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.clock = clock;
    this.tokens = burst;
    this.last = clock.now();
  }

  async take(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.clock.sleep(Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000));
    }
  }
}

export interface HttpStats {
  requests: number;
  retries: number;
  throttled: number; // 429 responses
  statuses: Record<string, number>;
}

export interface HttpClientOptions {
  rateLimit: { requestsPerSecond: number; burst: number };
  retry: { maxAttempts: number; baseDelayMs: number };
  fetchImpl?: typeof fetch;
  clock?: Clock;
  timeoutMs?: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class PayerHttp {
  readonly stats: HttpStats = { requests: 0, retries: 0, throttled: 0, statuses: {} };
  /** Extra request headers, e.g. the current member's bearer token. Sent only to `origin`. */
  headers: Record<string, string> = {};
  /** The payer's own origin. Credentials never go to another host (e.g. via a Bundle next link). */
  origin: string | null = null;
  private readonly bucket: TokenBucket;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly opts: HttpClientOptions;

  constructor(opts: HttpClientOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? realClock;
    this.bucket = new TokenBucket(opts.rateLimit.requestsPerSecond, opts.rateLimit.burst, this.clock);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** GET JSON. Returns the final status and body (null if not 2xx). Network errors are retried like 503s. */
  async get<T>(url: string): Promise<{ status: number; body: T | null }> {
    const { maxAttempts, baseDelayMs } = this.opts.retry;
    for (let attempt = 1; ; attempt++) {
      await this.bucket.take();
      this.stats.requests++;
      let status: number;
      let res: Response | null = null;
      try {
        res = await this.fetchImpl(url, {
          headers: { accept: 'application/fhir+json, application/json;q=0.9', ...(this.origin === null || new URL(url).origin === this.origin ? this.headers : {}) },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });
        status = res.status;
      } catch {
        status = 503;
      }
      this.stats.statuses[status] = (this.stats.statuses[status] ?? 0) + 1;
      if (status === 429) this.stats.throttled++;

      if (RETRYABLE.has(status) && attempt < maxAttempts) {
        this.stats.retries++;
        const retryAfter = Number(res?.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** (attempt - 1);
        await this.clock.sleep(delay);
        continue;
      }
      if (!res || !res.ok) return { status, body: null };
      return { status, body: (await res.json()) as T };
    }
  }
}
