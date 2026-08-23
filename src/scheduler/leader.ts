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

import type { Redis } from 'ioredis';
import { config, instanceId } from '../config.js';
import { logger } from '../logger.js';
import { key, redisEnabled, sharedRedis } from '../redis/index.js';

/**
 * Takes the lease, or renews it if we already hold it.
 *
 * `GET` then `SET` in one script, so two replicas asking simultaneously cannot
 * both be told yes. Renewal is the same call as acquisition, which is what makes
 * the leader's steady state a single round trip per tick.
 */
const ACQUIRE_OR_RENEW = `
local current = redis.call('GET', KEYS[1])
if current == false or current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
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
      const won = (await scripts().leaderClaim(this.leaseKey, instanceId, String(this.ttlMs))) === 1;

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

  /** Gives the lease up at shutdown so the next instance does not wait out the TTL. */
  async release(): Promise<void> {
    if (!redisEnabled() || !this.leader) return;
    this.leader = false;
    try {
      await scripts().leaderRelease(this.leaseKey, instanceId);
      logger.info({ lease: this.name }, 'released the sweep lease');
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
