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
 * · CHAIN_SIGNING_KEY must be set. Without it every instance generates its
 *   own key and the chain is signed by several — see lib/signing.js. The
 *   handler below refuses to start rather than let that happen quietly.
 * · The chain heads FILE sink is lost; only the webhook sink survives.
 * · A cold start pays for a fresh Atlas connection.
 *
 * None of that is a reason to avoid this for testing. All of it is a reason
 * not to put real employees on it.
 */

import serverless from 'serverless-http';
import { buildApp } from '../../src/app.js';
import { config, assertProductionSafe } from '../../src/config.js';
import { connect, assertDeploymentSupportsChain } from '../../src/db/mongo.js';

// Module scope, so a warm instance reuses the connection instead of opening
// one per request. `ready` is the promise, deliberately not the result: two
// concurrent invocations on the same instance must await the same connect.
let ready = null;

async function boot() {
  // The same refusals server.js makes. A no-op unless NODE_ENV=production,
  // and the whole point is that setting NODE_ENV=production here must mean
  // the same thing it means on a real host — not merely a different log level.
  assertProductionSafe();

  if (!process.env.CHAIN_SIGNING_KEY) {
    throw new Error(
      'CHAIN_SIGNING_KEY is required on a serverless host. Without it each ' +
      'instance mints its own key and the chain is signed by several, none ' +
      'of which verify against the others.',
    );
  }
  await connect();
  // The same refusal as server.js. Atlas is always a replica set, so this
  // passes there — it is here to catch a URI pointed at something else.
  await assertDeploymentSupportsChain();
  return serverless(buildApp());
}

/**
 * The redirect in netlify.toml sends `/health` here as
 * `/.netlify/functions/api/health`, and Express would answer that with a 404
 * because no such route exists. Strip the prefix so the app sees the path the
 * caller actually asked for.
 *
 * Written to tolerate both shapes: which one arrives has varied between
 * Netlify's runtimes, and a handler that only survives one of them is a
 * handler that breaks on their next release.
 */
const FUNCTION_PREFIX = '/.netlify/functions/api';

function normalisePath(event) {
  const path = event.path ?? '/';
  if (!path.startsWith(FUNCTION_PREFIX)) return event;
  const stripped = path.slice(FUNCTION_PREFIX.length) || '/';
  return { ...event, path: stripped.startsWith('/') ? stripped : `/${stripped}` };
}

export const handler = async (event, context) => {
  // Lambda resolves the response before the connection pool is idle, and
  // waiting for it would add the pool teardown to every single request.
  context.callbackWaitsForEmptyEventLoop = false;

  ready ??= boot();

  let wrapped;
  try {
    wrapped = await ready;
  } catch (err) {
    ready = null; // let the next invocation retry rather than cache the failure
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: 'NOT_CONFIGURED',
        message:
          config.env === 'production'
            ? 'The service is not available.'
            : err.message,
      }),
    };
  }

  return wrapped(normalisePath(event), context);
};
