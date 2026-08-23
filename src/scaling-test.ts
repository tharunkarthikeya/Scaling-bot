/**
 * Proofs for the horizontal architecture.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  `smoke.ts` proves the protocol: what the bot says, and when. This proves the
 *  topology: that a second instance is safe to start. They are separate suites
 *  because they need separate things — smoke needs nothing, and half of this
 *  needs a real Redis.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   npm run test:scaling
 *
 * Point it at a Redis with TEST_REDIS_URL, or run the one in the load-test
 * compose file:
 *
 *   docker compose -f loadtest/docker-compose.yml up -d redis
 *
 * ## Why some of this forks child processes
 *
 * `withCandidateLock` puts a per-key promise chain in front of the Redis lock,
 * so two callers inside one process are serialised by the chain and never reach
 * the part under test. A single-process test of mutual exclusion would pass
 * whether or not the Redis lock existed. So the lock tests fork two real
 * processes — separate module registries, separate chains, separate instance
 * ids — which is what two containers behind a load balancer actually are.
 *
 * ## Without Redis
 *
 * The role and metrics tests still run; everything else is reported as not
 * proven and the suite EXITS NON-ZERO. That is deliberate. A suite that goes
 * quietly green when the thing it tests is absent is worse than no suite, and
 * "no Redis in CI" must not read as "distributed locking works".
 * Set ALLOW_SKIP_REDIS_TESTS=true to override, knowingly.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { Redis } from 'ioredis';

/* ------------------------------------------------------------------ */
/* Environment, before anything reads it                               */
/* ------------------------------------------------------------------ */

const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

/**
 * Every key this run writes, under a prefix nothing else uses.
 *
 * So the suite cannot collide with a development Redis, cannot collide with
 * itself if two runs overlap, and can be deleted wholesale at the end by
 * pattern.
 */
const RUN = `adira-test-${crypto.randomBytes(4).toString('hex')}`;

/** Required variables the application refuses to start without. Values are irrelevant here. */
const REQUIRED_DEFAULTS: Record<string, string> = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  MONGODB_DB: 'adira_scaling_test',
  WHATSAPP_APP_SECRET: 'test-app-secret',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'test-verify-token',
  WHATSAPP_ACCESS_TOKEN: 'test-access-token',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  VERIS_OCR_BASE_URL: 'http://127.0.0.1:8789',
  VERIS_OCR_API_KEY: 'test-ocr-key',
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
};

for (const [name, value] of Object.entries(REQUIRED_DEFAULTS)) process.env[name] ??= value;

process.env.REDIS_KEY_PREFIX = RUN;
// Short, so the "gave up waiting" test is quick. Production waits 30s.
process.env.LOCK_ACQUIRE_TIMEOUT_MS = '2000';
process.env.LOCK_TTL_MS = '5000';

/**
 * Is there a Redis?
 *
 * Probed before `REDIS_URL` is set, so that an absent Redis leaves the
 * application in its single-instance configuration rather than in a
 * configured-but-unreachable one, where every module would sit retrying a
 * connection in the background for the length of the run.
 */
async function probeRedis(): Promise<boolean> {
  const probe = new Redis(TEST_REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1_500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const REDIS_AVAILABLE = await probeRedis();

// Set either way, and never left alone. `config.ts` loads dotenv, and dotenv
// fills in anything absent — so on a machine whose .env carries a deployment's
// Redis, leaving this unset would point the "no Redis" path at a host that is
// unreachable rather than at no host at all, and the checks that are supposed to
// run locally would fail on a connection instead. Blank is read as unset.
process.env.REDIS_URL = REDIS_AVAILABLE ? TEST_REDIS_URL : '';

/* ------------------------------------------------------------------ */
/* Imports, after the environment is settled                           */
/* ------------------------------------------------------------------ */

const { planFor, describePlan } = await import('./roles.js');
const { buildServer } = await import('./server.js');
const { startEventLoopMonitor, record } = await import('./metrics/index.js');
const { withCandidateLock, LockTimeoutError, lockStats } = await import('./queue/lock.js');
const { RedisRateLimiter, resetLimiterStatsForTests } = await import('./whatsapp/rateLimiter.js');
const { RedisQueue } = await import('./queue/index.js');
const { Lease } = await import('./scheduler/leader.js');
const { sharedRedis, closeRedis, key: nsKey } = await import('./redis/index.js');

/* ------------------------------------------------------------------ */
/* Runner — same shape as smoke.ts                                     */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures: string[] = [];
const unproven: string[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  \x1b[32mok\x1b[0m  ${name}`);
    })
    .catch((err) => {
      failures.push(name);
      console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
      console.log(`       ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    });
}

/** A check that needs Redis. Recorded as not proven when there is none. */
function needsRedis(name: string, fn: () => void | Promise<void>): Promise<void> {
  if (!REDIS_AVAILABLE) {
    unproven.push(name);
    console.log(`  \x1b[33mNOT PROVEN\x1b[0m  ${name}`);
    return Promise.resolve();
  }
  return check(name, fn);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'testing', 'scalingChild.ts');

/**
 * Runs N copies of the child at once and waits for all of them.
 *
 * `--import tsx` explicitly rather than inherited, because the child is
 * TypeScript and a forked process does not necessarily carry the parent's
 * loader.
 */
async function forkChildren(count: number, args: string[]): Promise<number[]> {
  const runs = Array.from({ length: count }, () =>
    new Promise<number>((resolve, reject) => {
      const child = fork(CHILD, args, {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      child.on('exit', (code) => resolve(code ?? -1));
      child.on('error', reject);
    }),
  );
  return Promise.all(runs);
}

/* ================================================================== */
/* Roles — no Redis needed                                             */
/* ================================================================== */

console.log('\nprocess roles — each does its own job and only its own job');

await check('web serves the webhook and consumes nothing', () => {
  const plan = planFor('web', true);
  assert.equal(plan.webhook, true);
  assert.equal(plan.workers, false, 'a web instance would consume jobs');
  assert.equal(plan.sweeps, false, 'a web instance would run sweeps');
  assert.equal(plan.requiresRedis, true);
});

await check('worker consumes and serves no webhook', () => {
  const plan = planFor('worker', true);
  assert.equal(plan.workers, true);
  assert.equal(plan.webhook, false, 'a worker would accept webhooks');
  assert.equal(plan.sweeps, false, 'a worker would also sweep');
  assert.equal(plan.requiresRedis, true);
});

await check('scheduler sweeps, behind an election, and does nothing else', () => {
  const plan = planFor('scheduler', true);
  assert.equal(plan.sweeps, true);
  assert.equal(plan.leaderElection, true, 'every scheduler replica would sweep');
  assert.equal(plan.webhook, false);
  assert.equal(plan.workers, false);
});

await check('all does everything, and elects only when there is a Redis to elect through', () => {
  const withRedis = planFor('all', true);
  assert.equal(withRedis.webhook, true);
  assert.equal(withRedis.workers, true);
  assert.equal(withRedis.sweeps, true);
  assert.equal(withRedis.leaderElection, true);
  // One instance, no Redis: it is the leader by being the only candidate.
  assert.equal(planFor('all', false).leaderElection, false);
  assert.equal(withRedis.requiresRedis, false, 'the default deployment would need Redis');
});

await check('every role but `all` refuses to run without Redis', () => {
  for (const role of ['web', 'worker', 'scheduler'] as const) {
    assert.equal(planFor(role, true).requiresRedis, true, `${role} would start unshared`);
  }
  assert.equal(planFor('all', true).requiresRedis, false);
});

await check('the three roles between them cover the whole application', () => {
  // No duty may be dropped by splitting. Whatever `all` does, the three roles
  // together must also do — otherwise a split deployment silently stops doing
  // something and nobody finds out until a sweep has not run for a week.
  const all = planFor('all', true);
  const split = [planFor('web', true), planFor('worker', true), planFor('scheduler', true)];

  for (const duty of ['webhook', 'workers', 'sweeps'] as const) {
    if (all[duty]) {
      assert.ok(
        split.some((plan) => plan[duty]),
        `no role performs "${duty}", which ROLE=all does`,
      );
    }
  }
});

await check('describePlan names what a container is', () => {
  assert.match(describePlan(planFor('web', true)), /^web: webhook\+api$/);
  assert.match(describePlan(planFor('worker', true)), /^worker: ops-only \+ workers$/);
  assert.match(describePlan(planFor('scheduler', true)), /sweeps\(elected\)/);
});

/* ================================================================== */
/* Metrics and the ops-only server                                     */
/* ================================================================== */

console.log('\nops-only server — health and metrics, and nothing that carries PII');

await check('a worker serves /health but not the webhook or the admin API', async () => {
  const app = await buildServer({ webhook: false });

  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(JSON.parse(health.body).ok, true);

  // The routes that carry candidate PII are not merely guarded on this role —
  // they are not registered at all.
  assert.equal((await app.inject({ method: 'GET', url: '/webhook' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/webhook' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/candidates' })).statusCode, 404);

  await app.close();
});

await check('/metrics renders every family the architecture is judged on', async () => {
  startEventLoopMonitor();
  record.http('POST', '/webhook', 200, 0.03);
  record.jobStarted('ocr');
  record.jobFinished('ocr', 12.5, true);
  record.error('graph');

  const app = await buildServer({ webhook: false });
  const res = await app.inject({ method: 'GET', url: '/metrics' });

  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/plain/);

  for (const family of [
    'adira_http_request_duration_seconds_bucket', // http latency
    'adira_queue_waiting', // queue depth
    'adira_worker_utilisation', // worker utilisation
    'adira_rate_limit_wait_avg_seconds', // redis limiter waits
    'adira_model_in_flight', // model concurrency
    'adira_jobs_completed_total{job="ocr"}', // ocr jobs
    'adira_errors_total{source="graph"}', // errors
    'adira_event_loop_lag_seconds', // event-loop lag
    'adira_lock_contended_total', // lock contention
  ]) {
    assert.ok(res.body.includes(family), `/metrics is missing ${family}`);
  }

  await app.close();
});

await check('/metrics cannot be made to carry a candidate identifier', async () => {
  const app = await buildServer({ webhook: false });

  // A per-candidate label would be an unbounded series and a PII leak in the
  // same mistake, so routes are labelled by pattern and unmatched requests are
  // labelled `unmatched`. Scanning traffic must not be able to create series.
  const waId = '919876543210';
  await app.inject({ method: 'GET', url: `/api/candidates/${waId}` });

  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.ok(!res.body.includes(waId), '/metrics leaked a waId into a label');
  assert.ok(res.body.includes('route="unmatched"'), 'unmatched requests were not collapsed');

  await app.close();
});

/* ================================================================== */
/* The candidate lock                                                  */
/* ================================================================== */

console.log('\ncandidate lock — one candidate, one turn, across the fleet');

await needsRedis('a lock held by another instance is not granted twice', async () => {
  const redis = sharedRedis();
  const waId = `9190000${Date.now() % 100000}`;
  const lockKey = nsKey('lock', 'candidate', waId);

  // Stand in for another instance holding it. Longer than the acquire timeout,
  // so the only way through is to take a lock somebody else has.
  await redis.set(lockKey, '99:another-instance:token', 'PX', 6_000);

  let ran = false;
  await assert.rejects(
    withCandidateLock(waId, async () => {
      ran = true;
    }),
    LockTimeoutError,
    'the lock was granted while another instance held it',
  );

  assert.equal(ran, false, 'the callback ran without the lock');

  // And the foreign lock is untouched: release is compare-and-swap, so a
  // process that failed to acquire cannot delete the holder's lock on its way
  // out. This is the failure that turns a lock into an ornament.
  assert.equal(await redis.get(lockKey), '99:another-instance:token');
  await redis.del(lockKey);
});

await needsRedis('a released lock is granted to the next caller', async () => {
  const redis = sharedRedis();
  const waId = `9190001${Date.now() % 100000}`;
  const lockKey = nsKey('lock', 'candidate', waId);

  // Held briefly, then expired by Redis. The waiter should get it.
  await redis.set(lockKey, '99:another-instance:token', 'PX', 400);

  const startedAt = Date.now();
  const got = await withCandidateLock(waId, async () => 'ran');

  assert.equal(got, 'ran');
  assert.ok(Date.now() - startedAt >= 300, 'the lock was granted before the holder let it go');
});

await needsRedis('fencing tokens increase, so a delayed writer is recognisable', async () => {
  const waId = `9190002${Date.now() % 100000}`;

  const first = await withCandidateLock(waId, async (lock) => lock?.fence ?? 0);
  const second = await withCandidateLock(waId, async (lock) => lock?.fence ?? 0);

  assert.ok(first > 0, 'no fence was issued');
  assert.ok(second > first, `fence did not advance: ${first} then ${second}`);
});

await needsRedis('two bot instances never hold one candidate at the same time', async () => {
  const redis = sharedRedis();
  const runKey = `lockrace-${crypto.randomBytes(3).toString('hex')}`;
  const waId = '919000099999';

  // Two real processes, started together, both told to hold the same candidate
  // for 400ms. If the lock does not cross process boundaries they overlap.
  const codes = await forkChildren(2, ['lock', waId, '400', runKey]);
  assert.deepEqual(codes, [0, 0], 'a child instance failed');

  const ran = await redis.lrange(nsKey('test', runKey, 'ran'), 0, -1);
  assert.equal(ran.length, 2, 'both instances did not run');
  assert.equal(new Set(ran).size, 2, 'the two children reported the same instance id');

  // The high-water mark of simultaneous holders, counted atomically by Redis.
  const observed = (await redis.lrange(nsKey('test', runKey, 'observed'), 0, -1)).map(Number);
  assert.equal(observed.length, 2);
  assert.deepEqual(
    observed.filter((n) => n > 1),
    [],
    `two instances held the same candidate at once (observed ${observed.join(', ')})`,
  );
});

await needsRedis('the lock reports contention rather than hiding it', () => {
  const stats = lockStats();
  assert.equal(stats.distributed, true, 'the lock did not report itself as distributed');
  assert.ok(stats.acquired > 0, 'no acquisition was counted');
  assert.ok(stats.contended > 0, 'contention was never observed, though it was arranged');
});

/* ================================================================== */
/* Rate limits                                                         */
/* ================================================================== */

console.log('\nrate limits — one budget, however many instances');

await needsRedis('two limiters on one budget share it rather than doubling it', async () => {
  resetLimiterStatsForTests();
  const budget = `test-replies-${crypto.randomBytes(3).toString('hex')}`;

  // Two instances of the limiter, as two containers would each have.
  const a = new RedisRateLimiter(10, budget);
  const b = new RedisRateLimiter(10, budget);

  let granted = 0;
  for (let i = 0; i < 15; i++) {
    if (await a.tryAcquire()) granted += 1;
    if (await b.tryAcquire()) granted += 1;
  }

  // The old per-process bucket would have handed out 10 to each, i.e. 20 — the
  // exact failure that makes Meta drop messages when you scale out.
  assert.ok(granted <= 12, `a 10/sec budget granted ${granted} tokens to two limiters`);
  assert.ok(granted >= 9, `a 10/sec budget granted only ${granted} tokens`);
});

await needsRedis('separate budgets do not spend each other', async () => {
  const suffix = crypto.randomBytes(3).toString('hex');
  const replies = new RedisRateLimiter(5, `test-replies-${suffix}`);
  const receipts = new RedisRateLimiter(5, `test-receipts-${suffix}`);

  let drained = 0;
  while (drained < 50 && (await receipts.tryAcquire())) drained += 1;
  assert.ok(drained > 0);
  assert.equal(await receipts.tryAcquire(), false, 'the receipt budget did not run out');

  // The whole point of the split: a drained receipt budget costs replies nothing.
  assert.equal(await replies.tryAcquire(), true, 'draining receipts cost reply capacity');
});

await needsRedis('a shared bucket refills on its own', async () => {
  const budget = `test-refill-${crypto.randomBytes(3).toString('hex')}`;
  const limiter = new RedisRateLimiter(20, budget);

  let drained = 0;
  while (drained < 100 && (await limiter.tryAcquire())) drained += 1;
  assert.equal(await limiter.tryAcquire(), false);

  await sleep(200);
  assert.equal(await limiter.tryAcquire(), true, 'the shared budget never refilled');
});

await needsRedis('two bot instances share one budget across processes', async () => {
  const redis = sharedRedis();
  const runKey = `raterace-${crypto.randomBytes(3).toString('hex')}`;
  const budget = `test-fleet-${crypto.randomBytes(3).toString('hex')}`;

  // Two processes, each trying to take 10 tokens from a 10/sec budget.
  const codes = await forkChildren(2, ['rate', budget, '10', runKey]);
  assert.deepEqual(codes, [0, 0], 'a child instance failed');

  const grants = (await redis.lrange(nsKey('test', runKey, 'granted'), 0, -1)).map(Number);
  assert.equal(grants.length, 2, 'both instances did not report');

  const total = grants.reduce((a, b) => a + b, 0);
  // Two processes, one budget. Per-process buckets would give 20.
  assert.ok(total <= 12, `a 10/sec budget granted ${total} tokens across two processes`);
  assert.ok(total >= 9, `a 10/sec budget granted only ${total} tokens across two processes`);
});

/* ================================================================== */
/* The queue                                                           */
/* ================================================================== */

console.log('\nqueue — many workers, each job done once');

await needsRedis('every job is handled exactly once by exactly one worker', async () => {
  const JOBS = 40;

  // Two queue objects with their own workers: two worker containers, in effect.
  // BullMQ duplicates the connection for its blocking reads, so sharing the
  // base connection is correct and is what the application does.
  const workerA = new RedisQueue();
  const workerB = new RedisQueue();
  const producer = new RedisQueue();

  const handledBy: string[] = [];
  const handled: string[] = [];
  let concurrentPeak = 0;
  let inFlight = 0;

  const done = new Promise<void>((resolve) => {
    const handler = (label: string) => async (payload: { wamid: string }) => {
      inFlight += 1;
      concurrentPeak = Math.max(concurrentPeak, inFlight);

      handled.push(payload.wamid);
      handledBy.push(label);

      // Long enough that both workers are genuinely in flight together, so a
      // job delivered twice would be delivered twice *concurrently*.
      await sleep(15);
      inFlight -= 1;

      if (handled.length === JOBS) resolve();
    };

    workerA.register('inbound_message', handler('a'), 4);
    workerB.register('inbound_message', handler('b'), 4);
  });

  await workerA.start();
  await workerB.start();

  for (let i = 0; i < JOBS; i++) {
    await producer.enqueue('inbound_message', { waId: `9190${i}`, wamid: `wamid.exactly-${i}` });
  }

  await Promise.race([done, sleep(20_000)]);

  await workerA.close();
  await workerB.close();
  await producer.close();

  assert.equal(handled.length, JOBS, `${handled.length} of ${JOBS} jobs were handled`);
  assert.equal(new Set(handled).size, JOBS, 'a job was handled more than once');
  assert.ok(concurrentPeak > 1, 'the workers never ran concurrently; the test proved nothing');

  // Both took work. One worker doing all of it would satisfy exactly-once and
  // tell us nothing about whether a second worker is usable.
  assert.ok(handledBy.includes('a'), 'worker A took no jobs');
  assert.ok(handledBy.includes('b'), 'worker B took no jobs');
});

await needsRedis('a web instance registers no handler and consumes nothing', async () => {
  // ROLE=web calls `observe`, never `register`. The separation is structural:
  // there is no handler to run, so a webhook process cannot pick up a job even
  // if one were somehow routed to it.
  const web = new RedisQueue();
  web.observe('inbound_message');
  await web.start();

  const consumer = new RedisQueue();
  let consumed = 0;
  consumer.register('inbound_message', async () => {
    consumed += 1;
  }, 1);

  await web.enqueue('inbound_message', { waId: '919000000001', wamid: 'wamid.web-role' });

  // Give the web instance every chance to consume it, then let a real worker
  // prove the job was still there to be had.
  await sleep(500);
  assert.equal(consumed, 0, 'the web instance consumed a job');

  const depth = await web.depth();
  assert.ok(depth.inbound_message, 'a web instance did not report queue depth');
  assert.equal(depth.inbound_message.concurrency, 0, 'a web instance claimed worker capacity');

  await consumer.start();
  await sleep(500);
  assert.equal(consumed, 1, 'the job was lost rather than left for a worker');

  await web.close();
  await consumer.close();
});

await needsRedis('queue depth is the fleet backlog, not this process', async () => {
  const producer = new RedisQueue();
  producer.observe('ocr');

  const before = (await producer.depth()).ocr?.waiting ?? 0;
  await producer.enqueue('ocr', { waId: '919000000002', docType: 'passport', uploadId: 'u1' });

  const after = (await producer.depth()).ocr?.waiting ?? 0;
  assert.equal(after, before + 1, 'an enqueued job did not appear in the depth reported to Prometheus');

  await producer.close();
});

/* ================================================================== */
/* Leader election                                                     */
/* ================================================================== */

console.log('\nsweep lease — N schedulers, one sweeper');

await needsRedis('only one holder of a lease at a time', async () => {
  const name = `sweeps-${crypto.randomBytes(3).toString('hex')}`;
  const a = new Lease(name, 5_000);
  const b = new Lease(name, 5_000);

  assert.equal(await a.claim(), true, 'the first claimant was refused');
  assert.equal(await b.claim(), false, 'two instances swept at once');

  // The holder keeps it, so a leader does not lose the duty by asking again.
  assert.equal(await a.claim(), true, 'the holder lost its own lease on renewal');
  assert.equal(a.isLeader, true);
  assert.equal(b.isLeader, false);
});

await needsRedis('a lease released at shutdown is taken up immediately', async () => {
  const name = `sweeps-${crypto.randomBytes(3).toString('hex')}`;
  const leaving = new Lease(name, 60_000);
  const arriving = new Lease(name, 60_000);

  assert.equal(await leaving.claim(), true);
  assert.equal(await arriving.claim(), false);

  // Without the release, the next instance waits out a 60s TTL — which during a
  // rolling deploy is a minute with nothing sweeping.
  await leaving.release();
  assert.equal(await arriving.claim(), true, 'the lease was not handed over on shutdown');
});

/* ================================================================== */
/* Teardown                                                            */
/* ================================================================== */

if (REDIS_AVAILABLE) {
  const redis = sharedRedis();
  const keys = await redis.keys(`${RUN}:*`);
  if (keys.length) await redis.del(...keys);
  await closeRedis();
}

const total = passed + failures.length;

console.log(
  failures.length
    ? `\n\x1b[31m${failures.length} of ${total} checks failed\x1b[0m\n` +
        failures.map((f) => `  - ${f}`).join('\n') +
        '\n'
    : `\n\x1b[32m${passed} checks passed\x1b[0m\n`,
);

if (unproven.length) {
  console.log(
    `\x1b[33m${unproven.length} checks were NOT PROVEN — no Redis at ${TEST_REDIS_URL}\x1b[0m\n` +
      unproven.map((f) => `  - ${f}`).join('\n') +
      '\n\n' +
      '  Start one with:  docker compose -f loadtest/docker-compose.yml up -d redis\n' +
      '  Or point at one: TEST_REDIS_URL=redis://host:6379 npm run test:scaling\n' +
      '\n  This is a FAILURE, not a skip. Everything above that was not proven is the\n' +
      '  part that makes a second instance safe to start, and a suite that goes green\n' +
      '  without it would be saying the opposite of what it checked.\n' +
      '  Set ALLOW_SKIP_REDIS_TESTS=true to accept that knowingly.\n',
  );
}

const skipAllowed = process.env.ALLOW_SKIP_REDIS_TESTS === 'true';
process.exit(failures.length || (unproven.length && !skipAllowed) ? 1 : 0);
