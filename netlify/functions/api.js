/**
 * The Pramaan API as a Netlify Function.
 *
 * Netlify has no long-running process, so `src/server.js` is never executed
 * here — that file stays the entry point for a real host. This wrapper hands
 * the same Express app to Lambda instead.
 *
 * ⚠ WHAT THIS DEPLOYMENT CANNOT DO, STATED PLAINLY.
 *
 * · Rate limiting is per instance. `express-rate-limit` counts in memory, so
 *   the OTP flood ceiling is multiplied by however many instances Netlify
 *   happens to be running. Gate 1 checks that ceiling; it does not hold here.
 *   It is at least counted PER CALLER — see trustNetlifyClientIp() below for
 *   why that took an extra step, and what it looked like when it did not.
 * · CHAIN_PRIVATE_KEY_PEM must be set. Without it every instance generates its
 *   own key and the chain is signed by several — see lib/signing.js. The
 *   handler below refuses to serve rather than let that happen quietly.
 * · The chain heads FILE sink is lost on a read-only filesystem; only the
 *   webhook sink survives, and it is the only one that was ever evidence.
 * · A cold start pays for a fresh Atlas connection.
 *
 * None of that is a reason to avoid this for testing. All of it is a reason
 * not to put real employees on it.
 */

import serverless from 'serverless-http';
import pino from 'pino';
import { buildApp } from '../../src/app.js';
import { config, assertProductionSafe } from '../../src/config.js';
import { connect, assertDeploymentSupportsChain } from '../../src/db/mongo.js';
import { trustNetlifyClientIp } from '../../src/lib/platform.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// This file is the only thing Netlify executes, so this is the one place the
// claim "we are on Netlify" is self-evidently true. It lets the rate limiter
// believe `x-nf-client-connection-ip`, which Netlify's edge sets and a caller
// cannot forge. Without it every request looks like the same anonymous caller
// and twenty of them lock every employee out of sign-in — see
// middleware/rate-limit.js.
trustNetlifyClientIp();

// Built once, at module scope, and deliberately without the database probe in
// /health. A health check that waits on Mongo cannot tell you Mongo is down —
// on Lambda it just burns the function's timeout and returns nothing at all.
const expressHandler = serverless(buildApp({ healthDatabase: false }));

// Module scope, so a warm instance reuses the connection instead of opening
// one per request. `ready` holds the PROMISE, deliberately not the result:
// two concurrent invocations on the same instance must await the same connect.
let ready = null;

async function boot() {
  // The same refusals server.js makes. A no-op unless NODE_ENV=production,
  // and the point is that setting NODE_ENV=production here means what it
  // means on a real host — not merely a different log level.
  assertProductionSafe();

  if (!config.chain.privateKeyPem && !process.env.CHAIN_KEY_PATH) {
    throw new Error(
      'CHAIN_PRIVATE_KEY_PEM is required on a serverless host. Without it each ' +
      'instance mints its own key and the chain is signed by several, none ' +
      'of which verify against the others.',
    );
  }

  await connect();
  // The same refusal as server.js. Atlas is always a replica set, so this
  // passes there — it is here to catch a URI pointed at something else.
  const deployment = await assertDeploymentSupportsChain();
  log.info({ replicaSet: deployment.replicaSet }, 'mongodb connected');
}

/**
 * Give Express the path the CALLER asked for.
 *
 * The rewrites in netlify.toml deliver `/health` here as
 * `/.netlify/functions/api/health`, and `/api/health` is accepted as well so
 * that a client configured with either base URL works. Express would answer
 * both with a 404, because neither route exists.
 *
 * Every field is normalised rather than just `path`: which one arrives has
 * varied between Netlify's runtimes, and a handler that survives only the
 * current one is a handler that breaks on their next release.
 */
const PREFIXES = ['/.netlify/functions/api', '/api'];

function stripDeployPrefix(path) {
  for (const prefix of PREFIXES) {
    if (path === prefix) return '/';
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  }
  return path;
}

function normaliseEvent(event) {
  const normalised = { ...event };
  for (const key of ['path', 'rawPath', 'requestPath']) {
    if (typeof normalised[key] === 'string') {
      normalised[key] = stripDeployPrefix(normalised[key]);
    }
  }
  return normalised;
}

/** /health answers on its own. Everything else needs a database. */
const isHealth = (event) => event.path === '/health' || event.rawPath === '/health';

export async function handler(event, context) {
  // Lambda resolves the response before the connection pool is idle, and
  // waiting for it would add the pool teardown to every single request.
  if (context) context.callbackWaitsForEmptyEventLoop = false;

  const normalised = normaliseEvent(event);

  // /health skips boot deliberately. The moment somebody looks at a health
  // endpoint is the moment the database or the configuration is broken, so an
  // endpoint that refuses to answer under exactly those conditions is useless.
  if (!isHealth(normalised)) {
    ready ??= boot();
    try {
      await ready;
    } catch (err) {
      // Retry on the next invocation rather than caching the failure for the
      // life of the instance — a missing variable gets fixed in the dashboard,
      // and Atlas comes back.
      ready = null;
      log.error({ err }, 'function failed to start');
      return {
        statusCode: 503,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          error: 'NOT_CONFIGURED',
          // The message names the missing variable, which is exactly what an
          // attacker would like to know about a production deployment.
          message:
            config.env === 'production' ? 'The service is not available.' : err.message,
        }),
      };
    }
  }

  return expressHandler(normalised, context);
}
