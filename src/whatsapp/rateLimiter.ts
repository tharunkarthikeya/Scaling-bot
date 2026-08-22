/**
 * Token bucket for one class of outbound Graph traffic.
 *
 * There is an instance per budget rather than one for everything — see
 * `client.ts`. Sharing a single bucket meant read receipts and media downloads
 * spent capacity that Meta grants for *sending messages*, so a candidate's reply
 * queued behind the acknowledgement of their own last one.
 *
 * 20/sec is the Coexistence limit for the production number. Exceeding it gets
 * messages dropped by Meta, not queued, which is why nothing here ever hands
 * back more than the bucket holds.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly perSecond: number) {
    this.tokens = perSecond;
  }

  /**
   * Waits for a token. For traffic that must not be lost — a reply, a document.
   */
  async acquire(): Promise<void> {
    for (;;) {
      if (this.tryAcquire()) return;
      // Wait for roughly one token's worth of time rather than spinning.
      const waitMs = Math.ceil(1000 / this.perSecond);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Takes a token if one is free, and reports whether it got one. Never waits.
   *
   * For traffic that is better dropped than delayed. A read receipt is a blue
   * tick: worth sending when there is room and worth forgetting when there is
   * not. Queueing them instead would pile up promises nobody is waiting on for
   * exactly as long as the overload lasts.
   */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Tokens available right now. Read-only; for tests and load instrumentation. */
  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.perSecond, this.tokens + elapsed * this.perSecond);
    this.lastRefill = now;
  }
}
