/**
 * The counters incremented on the hot path.
 *
 * Split from the collector next door for one reason: the queue has to increment
 * these, and the collector has to read the queue. Both in one module is a cycle.
 * This module imports nothing but the registry, so anything may import it.
 *
 * Everything here is O(1) and allocation-free in the common case. It runs on
 * every request and every job, so it has to be.
 */

import { counter, histogram, JOB_BUCKETS, LATENCY_BUCKETS } from './registry.js';

const httpRequests = counter('adira_http_requests_total', 'HTTP requests served, by route and status.');

const httpDuration = histogram(
  'adira_http_request_duration_seconds',
  'Time to serve an HTTP request. For /webhook this is the acknowledgement Meta waits on, not the time to reply to the candidate.',
  LATENCY_BUCKETS,
);

const jobsStarted = counter('adira_jobs_started_total', 'Jobs picked up by a worker in this process.');
const jobsCompleted = counter('adira_jobs_completed_total', 'Jobs that finished without throwing.');
const jobsFailed = counter('adira_jobs_failed_total', 'Jobs whose handler threw. Retried by BullMQ; not retried by the in-process queue.');

const jobDuration = histogram(
  'adira_job_duration_seconds',
  'Handler execution time, excluding time spent waiting in the queue.',
  JOB_BUCKETS,
);

const errors = counter(
  'adira_errors_total',
  'Errors worth alerting on, by source. Distinct from job failures, which are retried.',
);

/** Called from the queue wrapper and the server hooks. Cheap by design. */
export const record = {
  http(method: string, route: string, status: number, seconds: number): void {
    const labels = { method, route, status: String(status) };
    httpRequests.inc(labels);
    httpDuration.observe(seconds, { method, route });
  },

  jobStarted(job: string): void {
    jobsStarted.inc({ job });
  },

  jobFinished(job: string, seconds: number, ok: boolean): void {
    jobDuration.observe(seconds, { job });
    if (ok) jobsCompleted.inc({ job });
    else jobsFailed.inc({ job });
  },

  /**
   * An error that is nobody's retry and somebody's problem.
   *
   * `source` is a short stable string — `redis`, `mongo`, `graph`, `ocr` — so
   * the series stays countable. Never pass a message: an unbounded label is how
   * a metrics endpoint becomes the thing that runs out of memory.
   */
  error(source: string): void {
    errors.inc({ source });
  },
};

