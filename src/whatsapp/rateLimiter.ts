/**
 * Token bucket for outbound sends.
 *
 * 20/sec is the Coexistence limit for the production number — exceeding it gets
 * messages dropped by Meta, not queued. Every outbound call goes through here.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly perSecond: number) {
    this.tokens = perSecond;
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Wait for roughly one token's worth of time rather than spinning.
      const waitMs = Math.ceil(1000 / this.perSecond);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.perSecond, this.tokens + elapsed * this.perSecond);
    this.lastRefill = now;
  }
}
