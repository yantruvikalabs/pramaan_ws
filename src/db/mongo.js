/**
 * The MongoDB connection.
 *
 * Replaces the mysql2 pool in `src/db.js`. Every option below answers a hazard
 * MEASURED in D1 or D2 (see docs/mongodb-migration-plan.md §L, §M) — none of
 * them is a preference, and dropping any one reintroduces a silent corruption
 * rather than an error.
 */

import { MongoClient } from 'mongodb';
import { config } from '../config.js';

/**
 * ⚠ Do not edit without re-running `npm run d1`.
 *
 *   promoteBuffers  D1 measured this OFF by default. A BSON Binary exposes
 *                   `.length` as a METHOD, so lib/embed.js would compute
 *                   `new Array(NaN)` on every stored face template.
 *   promoteLongs    ON by default, but load-bearing: an int64 returned as a
 *                   Long object canonicalises as {"high":..,"low":..} instead
 *                   of a bare integer, and every event reads as ALTERED.
 *   ignoreUndefined An undefined must be stored as an explicit null, never
 *                   dropped. A missing key reads back as undefined, and
 *                   Number(undefined) is NaN, which canonical.js refuses.
 *   readPreference  A head read from a secondary can lag the chain, so two
 *                   appenders chain onto different heads and the chain forks.
 *   readConcern     Reading a head that is not majority-committed can chain
 *                   onto an event that is later rolled back — a BROKEN_LINK
 *                   that cannot be repaired.
 *   writeConcern    An event acknowledged to a phone (which then marks it
 *                   CONFIRMED and stops re-sending) must not be discardable by
 *                   a primary step-down. j:true survives a process death.
 */
export const REQUIRED_CLIENT_OPTIONS = Object.freeze({
  promoteBuffers: true,
  promoteLongs: true,
  ignoreUndefined: false,
  readPreference: 'primary',
  readConcern: { level: 'majority' },
  writeConcern: { w: 'majority', j: true },
});

/** Transaction settings for anything that touches the chain. */
export const CHAIN_TXN_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority', j: true },
  readPreference: 'primary',
});

let client = null;

export function getClient() {
  if (client === null) {
    client = new MongoClient(config.mongo.uri, {
      ...REQUIRED_CLIENT_OPTIONS,
      serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMs,
      connectTimeoutMS: config.mongo.connectTimeoutMs,
    });
  }
  return client;
}

export async function connect() {
  const c = getClient();
  await c.connect();
  return c;
}

export function getDb() {
  return getClient().db(config.mongo.database);
}

/** Shorthand, so call sites read like the collection they touch. */
export const col = (name) => getDb().collection(name);

export async function closeClient() {
  if (client !== null) {
    await client.close();
    client = null;
  }
}

/**
 * Refuse to run against a deployment that cannot keep the chain correct.
 *
 * Called at startup. A standalone mongod accepts every write in this codebase
 * and silently loses the transaction guarantee the appender depends on, so the
 * failure would appear later as a forked or gapped chain rather than as a
 * connection error. Better to not start.
 */
export async function assertDeploymentSupportsChain() {
  const hello = await getDb().admin().command({ hello: 1 });
  if (!hello.setName && !hello.msg) {
    throw new Error(
      'MongoDB is not a replica set or sharded cluster. The evidence chain ' +
      'requires multi-document transactions to keep `seq` gapless; a standalone ' +
      'mongod has none. Use a replica set (Atlas is one by default).',
    );
  }
  return { replicaSet: hello.setName ?? null, primary: Boolean(hello.isWritablePrimary) };
}
