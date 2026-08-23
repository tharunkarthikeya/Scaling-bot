/**
 * A very small Prometheus registry.
 *
 * Hand-written rather than pulled in, for the same reason this application has
 * nine dependencies and not ninety: what is needed here is three metric types
 * and a text encoder, the format is stable and specified, and a scrape endpoint
 * is not where a supply chain risk is worth taking for a hundred and fifty
 * lines of code.
 *
 * Deliberately not a copy of the load-test rig's `Histogram`. That one keeps
 * every sample so it can report exact percentiles over a bounded run; this one
 * keeps bucket counts, because a long-running server that remembered every
 * request would be a memory leak with a `/metrics` endpoint attached.
 *
 * This module imports nothing from the application, which is what lets the
 * queue instrument itself without a cycle back through the collector.
 */

/** Label values, ordered by key so one label set produces one series. */
export type Labels = Record<string, string | number>;

function encodeLabels(labels: Labels | undefined): string {
  if (!labels) return '';
  const entries = Object.entries(labels).filter(([, v]) => v !== undefined && v !== '');
  if (!entries.length) return '';

  const encoded = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escape(String(v))}"`)
    .join(',');

  return `{${encoded}}`;
}

/** Backslash, double quote and newline are the three the format cares about. */
function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  abstract render(): string[];

  protected header(type: string): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${type}`];
  }
}

/** Only ever goes up. Requests served, jobs failed, receipts dropped. */
export class Counter extends Metric {
  private readonly values = new Map<string, { labels?: Labels; value: number }>();

  inc(labels?: Labels, by = 1): void {
    const key = encodeLabels(labels);
    const existing = this.values.get(key);
    if (existing) existing.value += by;
    else this.values.set(key, { labels, value: by });
  }

  render(): string[] {
    const lines = this.header('counter');
    for (const [key, { value }] of this.values) lines.push(`${this.name}${key} ${value}`);
    // A counter that has never been incremented still deserves to exist, or a
    // dashboard shows "no data" where it should show zero.
    if (this.values.size === 0) lines.push(`${this.name} 0`);
    return lines;
  }
}

/** Goes up and down. Queue depth, in-flight calls, tokens left in a bucket. */
export class Gauge extends Metric {
  private readonly values = new Map<string, { labels?: Labels; value: number }>();

  set(value: number, labels?: Labels): void {
    this.values.set(encodeLabels(labels), { labels, value });
  }

  /** Drops every series. For gauges rebuilt from scratch on each scrape. */
  clear(): void {
    this.values.clear();
  }

  render(): string[] {
    const lines = this.header('gauge');
    for (const [key, { value }] of this.values) {
      // NaN renders as `NaN` which is valid, but it is never what was meant.
      if (Number.isFinite(value)) lines.push(`${this.name}${key} ${value}`);
    }
    return lines;
  }
}

/**
 * Bucketed observations. Latency, and nothing else here.
 *
 * Buckets are cumulative, as the format requires: `le="0.5"` counts everything
 * at or below half a second, including everything already counted by `le="0.1"`.
 */
export class Histogram extends Metric {
  private readonly series = new Map<
    string,
    { labels?: Labels; buckets: number[]; sum: number; count: number }
  >();

  constructor(
    name: string,
    help: string,
    private readonly bounds: number[],
  ) {
    super(name, help);
  }

  observe(value: number, labels?: Labels): void {
    const key = encodeLabels(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, buckets: new Array(this.bounds.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }

    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.bounds.length; i++) {
      if (value <= this.bounds[i]!) entry.buckets[i] = entry.buckets[i]! + 1;
    }
  }

  render(): string[] {
    const lines = this.header('histogram');

    for (const [, entry] of this.series) {
      const base = entry.labels ?? {};
      for (let i = 0; i < this.bounds.length; i++) {
        lines.push(
          `${this.name}_bucket${encodeLabels({ ...base, le: String(this.bounds[i]) })} ${entry.buckets[i]}`,
        );
      }
      lines.push(`${this.name}_bucket${encodeLabels({ ...base, le: '+Inf' })} ${entry.count}`);
      lines.push(`${this.name}_sum${encodeLabels(base)} ${entry.sum}`);
      lines.push(`${this.name}_count${encodeLabels(base)} ${entry.count}`);
    }

    return lines;
  }
}

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

const metrics: Metric[] = [];

function register<T extends Metric>(metric: T): T {
  metrics.push(metric);
  return metric;
}

/**
 * Seconds, always.
 *
 * Prometheus convention, and worth following even though everything else in
 * this codebase measures milliseconds: a dashboard that mixes units is a
 * dashboard that will eventually be read wrong.
 */
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Jobs run for far longer than requests. An OCR extraction can take two minutes. */
export const JOB_BUCKETS = [0.05, 0.25, 1, 2.5, 5, 10, 30, 60, 120, 300];

export function counter(name: string, help: string): Counter {
  return register(new Counter(name, help));
}

export function gauge(name: string, help: string): Gauge {
  return register(new Gauge(name, help));
}

export function histogram(name: string, help: string, bounds: number[]): Histogram {
  return register(new Histogram(name, help, bounds));
}

/** The whole registry, in the text exposition format, newline-terminated. */
export function renderRegistry(): string {
  return metrics.flatMap((m) => m.render()).join('\n') + '\n';
}
