/** Latency bookkeeping. Kept exact — the sample counts here are small enough. */
export class Stats {
  private readonly values: number[] = [];

  add(v: number): void {
    this.values.push(v);
  }

  summary(): { count: number; avg: number; p50: number; p95: number; p99: number; max: number; min: number } {
    if (!this.values.length) return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0, min: 0 };
    const sorted = [...this.values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: sorted.length,
      avg: round(sum / sorted.length),
      p50: round(percentile(sorted, 0.5)),
      p95: round(percentile(sorted, 0.95)),
      p99: round(percentile(sorted, 0.99)),
      max: round(sorted[sorted.length - 1]!),
      min: round(sorted[0]!),
    };
  }
}

export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

const round = (n: number) => Math.round(n * 100) / 100;
