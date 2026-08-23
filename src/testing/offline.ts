/**
 * Declares a test process offline, before anything reads the environment.
 *
 * `smoke.ts` says of itself that it needs no Mongo, no Redis and no network,
 * and that stopped being true the moment the rate limiters became Redis-backed:
 * with `REDIS_URL` set, `createBudget` hands back a `RedisRateLimiter` and every
 * assertion about outbound budgets is suddenly a round trip. On a machine whose
 * `.env` carries a production Redis — which is internal to the deployment
 * network and unreachable from a laptop by design — the offline suite fails for
 * reasons that have nothing to do with what it is testing.
 *
 * Blanking the variable is what fixes it rather than deleting it: `config.ts`
 * loads dotenv, and dotenv fills in anything *absent*, so unsetting hands the
 * value in `.env` straight back. `blankable()` in `config.ts` reads an empty
 * string as unset, which is exactly the assignment that wins here.
 *
 * Import this FIRST, before `./config.js` and before anything that reaches it.
 * ES modules are evaluated in the order their imports appear, so first is the
 * only position that runs before config is parsed.
 */

process.env.REDIS_URL = '';
