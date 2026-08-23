/**
 * One sweeper, however many replicas.
 *
 * The sweeps are the part of this application that nobody asks for. Nothing
 * triggers them, they run on a timer, and every replica has the same timer. Left
 * alone, five scheduler containers means five reminder scans, five idle-session
 * scans and five CRM taxonomy fetches every tick.
 *
 * Worth being precise about what that costs, because it is less than it looks:
 * the sweeps themselves are already safe to run twice. `sendReminders` claims
 * per candidate in the database, `endIdleSessions` closes with a conditional
 * update and checks `modifiedCount`, `sweepRunningExtractions` claims each
 * extraction, and the CRM submission is idempotent by key. Duplicating them
 * produces wasted reads, not duplicate messages — with one exception, the CRM
 * taxonomy refresh, which is an unconditional outbound fetch and would be
 * multiplied exactly by the replica count.
 *
 * So this is not a correctness patch on top of unsafe sweeps. It is the thing
 * that stops a fleet paying N times over for work that only needed doing once,
 * and it is deliberately a *lease* rather than a coordinated election: whoever
 * holds the key sweeps, it expires if they stop renewing it, and the next tick
 * from any replica picks it up. There is no consensus, no split-brain to
 * resolve, and the worst case — two leaders for a few seconds around a
 * handover — lands back on the duplicate-safe sweeps described above.
 */

import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { config, instanceId } from '../config.js';
import { logger } from '../logger.js';
import { key, redisEnabled, sharedRedis } from '../redis/index.js';

/**
 * Takes the lease, or renews it if we already hold it.
 *
 * `SET NX PX` first, which is the whole acquisition: Redis grants it to exactly
 * one caller and refuses everyone else, atomically, with no read-then-write
 * window for two schedulers to race through.
 *
 * Only if that refusal comes back is the holder's token compared, and only a
 * match extends the TTL. That ordering matters. Reading first and writing after
 * — which is what this did — makes the *comparison* the gate rather than the
 * SET, so anything that can present the incumbent's token is handed the lease
 * as a renewal. The token therefore has to identify one claimant and nothing
 * coarser; see `owner` below for the identity that got this wrong.
 *
 * Still one round trip in the steady state, because a renewal is the same call.
 */
const ACQUIRE_OR_RENEW = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return 1
end
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

/** Steps down cleanly, so a rolling deploy hands over in milliseconds. */
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

interface LeaderScripts {
  leaderClaim(leaseKey: string, holder: string, ttlMs: string): Promise<number>;
  leaderRelease(leaseKey: string, holder: string): Promise<number>;
}

let scriptsReady: (Redis & LeaderScripts) | undefined;

function scripts(): Redis & LeaderScripts {
  if (scriptsReady) return scriptsReady;
  const connection = sharedRedis();
  connection.defineCommand('leaderClaim', { numberOfKeys: 1, lua: ACQUIRE_OR_RENEW });
  connection.defineCommand('leaderRelease', { numberOfKeys: 1, lua: RELEASE });
  scriptsReady = connection as Redis & LeaderScripts;
  return scriptsReady;
}

/** Tests only. */
export function resetLeaderScriptsForTests(): void {
  scriptsReady = undefined;
}

/**
 * The lease on one named duty.
 *
 * Named rather than global so the reminder sweep and the taxonomy refresh could
 * be held by different instances if that were ever wanted. Today they all share
 * `sweeps`, which is the simplest arrangement that is also the easiest to reason
 * about when something has not run.
 */
export class Lease {
  private leader = false;
  private readonly leaseKey: string;

  /**
   * Who holds it. Unique to this object, not to this process.
   *
   * This was `instanceId` — `hostname:pid` — and that was wrong, because the
   * thing that holds a lease is a `Lease`, not the process it happens to live
   * in. Two leases on one process presented the same token, so the second one's
   * *acquisition* was indistinguishable from the first one's *renewal* and both
   * were told they were the leader. Two schedulers in one container, or two on
   * hosts that shared a hostname and a pid, would have swept simultaneously
   * while Redis reported a single well-behaved holder.
   *
   * The instance id is kept as a prefix because it is what makes an unreleased
   * key attributable to a replica in an incident; the uuid is what makes the
   * token mean one claimant.
   */
  private readonly owner = `${instanceId}:${crypto.randomUUID()}`;

  /**
   * `ttlMs` must comfortably exceed the interval this lease is claimed at, or a
   * leader that is merely busy loses it to a replica that is merely idle, and
   * the fleet spends its time handing the duty back and forth.
   */
  constructor(
    readonly name: string,
    private readonly ttlMs = 60_000,
  ) {
    this.leaseKey = key('leader', name);
  }

  /** Whether this instance held the lease at the last check. */
  get isLeader(): boolean {
    return this.leader;
  }

  /**
   * Whether this instance may do the work right now.
   *
   * With no Redis there is nothing to coordinate through and exactly one
   * instance is supported, so the answer is always yes — the same reasoning that
   * makes the in-process queue and the local rate limiter correct in that
   * deployment.
   */
  async claim(): Promise<boolean> {
    if (!redisEnabled()) return true;

    try {
      const won =
        (await scripts().leaderClaim(this.leaseKey, this.owner, String(this.ttlMs))) === 1;

      // Log the edges only. A leader that has been the leader for a week should
      // not have said so ten thousand times.
      if (won !== this.leader) {
        logger.info(
          { lease: this.name, instance: instanceId },
          won ? 'took the sweep lease' : 'lost the sweep lease to another instance',
        );
      }

      this.leader = won;
      return won;
    } catch (err) {
      // Redis is unreachable. Standing down is the safe answer: the alternative
      // is every replica assuming it is the leader at exactly the moment they
      // cannot see each other.
      logger.warn({ err, lease: this.name }, 'could not check the sweep lease; standing down');
      this.leader = false;
      return false;
    }
  }

  /**
   * Gives the lease up at shutdown so the next instance does not wait out the
   * TTL.
   *
   * Attempted whenever there is a Redis, rather than only when `this.leader`
   * says we are the holder. The Lua compares the token before deleting, so a
   * call from a non-holder removes nothing — which means the local flag is not
   * load-bearing here, and shutdown does not depend on it being accurate. That
   * matters precisely in the case where it might not be: a renewal that failed
   * transiently leaves `leader` false while the key is still ours and still
   * unexpired, and skipping the delete there would strand the duty for a full
   * TTL during a rolling deploy.
   */
  async release(): Promise<void> {
    if (!redisEnabled()) {
      this.leader = false;
      return;
    }

    const wasLeader = this.leader;
    this.leader = false;

    try {
      const released = await scripts().leaderRelease(this.leaseKey, this.owner);
      if (released === 1) logger.info({ lease: this.name }, 'released the sweep lease');
      else if (wasLeader) {
        // Believed we held it and did not: it expired under us, and somebody
        // else may already have taken it. Worth a line, because it means the
        // work outran its TTL.
        logger.warn({ lease: this.name }, 'the sweep lease had already gone before release');
      }
    } catch (err) {
      logger.warn({ err, lease: this.name }, 'could not release the sweep lease; it will expire');
    }
  }
}

/**
 * Runs `work` on an interval, but only while this instance holds `lease`.
 *
 * The lease is claimed on every tick rather than on a separate heartbeat, so a
 * process whose event loop has stalled long enough to miss its ticks also stops
 * renewing — which is precisely when another instance should take over.
 */
export function scheduleWithLease(
  lease: Lease,
  intervalMs: number,
  name: string,
  work: () => Promise<unknown>,
): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      if (!(await lease.claim())) return;
      await work();
    } catch (err) {
      logger.error({ err, sweep: name }, 'sweep failed');
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
