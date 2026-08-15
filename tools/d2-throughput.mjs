/**
 * D2 · Throughput, MongoDB vs MySQL — the second half of the D2 exit gate.
 *
 * Both appenders serialise on a single point by design: MySQL on the
 * chain_head row lock, MongoDB on a compare-and-swap of the head document.
 * That is the correctness requirement, so the interesting number is not raw
 * speed but how each DEGRADES as concurrency rises.
 *
 * ⚠ Runs MySQL against a SCRATCH database, never the dev chain. The chain is
 *   append-only: benchmark events written to it could never be removed.
 *
 *   DB_NAME=pramaan_bench node src/db/migrate.js
 *   DB_NAME=pramaan_bench node tools/d2-throughput.mjs
 */

import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { query, closePool } from '../src/db.js';
import { appendEvent as appendMysql } from '../src/lib/chain.js';
import { connect, ensureSchema, appendEvent as appendMongo } from './d2-chain-mongo.mjs';

const URL = process.env.D2_MONGO_URL ?? 'mongodb://127.0.0.1:27018/pramaan_bench?replicaSet=rs0';
const LEVELS = [1, 10, 50];
const PER_LEVEL = 100;

if (config.db.database !== 'pramaan_bench') {
  console.error(`\n✗ refusing to run: DB_NAME is "${config.db.database}", not "pramaan_bench".`);
  console.error('  This benchmark appends to the chain, and the chain cannot be cleaned up.\n');
  process.exit(1);
}

const punch = (i) => ({
  event_id: randomUUID(),
  type: 'AttendancePunch',
  subject_ref: `SUB-${String(i % 7).padStart(36, '0')}`,
  payload: { kind: 'IN', n: i },
  captured_at: new Date(1786000000000 + i * 1000).toISOString(),
  uptime_ms: 1000 + i,
});

/** Fire `total` appends with at most `width` in flight, and time it. */
async function measure(fn, width, total, stats) {
  let next = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: width }, async () => {
    while (true) {
      const i = next; next += 1;
      if (i >= total) return;
      await fn(punch(i), stats);
    }
  }));
  const ms = Date.now() - started;
  return { ms, rate: total / (ms / 1000) };
}

const GENESIS = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

async function resetMongo(client) {
  await client.db().collection('events').deleteMany({}); // pramaan-guard:allow — benchmark scratch database
  await client.db().collection('chain_head').deleteMany({});
  await ensureSchema(client.db());
}

async function resetMysql() {
  await query('DELETE FROM events');            // pramaan-guard:allow — scratch bench DB, never the real chain
  await query('UPDATE chain_head SET seq = 0, hash = ? WHERE id = 1', [GENESIS]);
}

async function main() {
  console.log('\nD2 · THROUGHPUT — MongoDB vs MySQL');
  console.log(`${PER_LEVEL} appends per level, scratch databases only\n`);

  const client = await connect(URL);
  await client.db().dropDatabase();
  await resetMongo(client);
  await resetMysql();

  const rows = [];
  for (const width of LEVELS) {
    // CAS alone — the correctness path, with the in-process queue disabled.
    const rawStats = { bodyRuns: 0, retries: 0 };
    const raw = await measure(
      (p, s) => appendMongo(client, p, { stats: s, queue: false }), width, PER_LEVEL, rawStats);

    await resetMongo(client);

    // CAS plus the in-process queue — the fast path.
    const qStats = { bodyRuns: 0, retries: 0 };
    const queued = await measure(
      (p, s) => appendMongo(client, p, { stats: s }), width, PER_LEVEL, qStats);

    const mysql = await measure((p) => appendMysql(p), width, PER_LEVEL, null);

    rows.push({
      width,
      rawRate: raw.rate, queuedRate: queued.rate,
      mysqlMs: mysql.ms, mysqlRate: mysql.rate,
      // How many times the transaction body ran for PER_LEVEL successful
      // appends. 1.0 means no contention; 3.0 means each append was attempted
      // three times on average, re-signing every time.
      rawAmp: rawStats.bodyRuns / PER_LEVEL,
      queuedAmp: qStats.bodyRuns / PER_LEVEL,
    });

    await resetMongo(client);
    await resetMysql();
  }

  console.log('| in flight | Mongo CAS only | Mongo + queue | MySQL row lock | body runs/append |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${String(r.width).padEnd(9)} ` +
      `| ${r.rawRate.toFixed(1).padStart(6)}/s ` +
      `| ${r.queuedRate.toFixed(1).padStart(6)}/s ` +
      `| ${r.mysqlRate.toFixed(1).padStart(6)}/s ` +
      `| ${r.rawAmp.toFixed(2)} → ${r.queuedAmp.toFixed(2)} |`,
    );
  }

  const worst = Math.min(...rows.map((r) => r.queuedRate));
  console.log(`\n  Worst MongoDB rate: ${worst.toFixed(1)} appends/s.`);
  console.log('  Against 2,000 employees punching twice a day, the peak is a dawn shift');
  console.log('  change — a few hundred punches inside ~30 minutes. Judge the number');
  console.log('  against that, not against a synthetic maximum.\n');

  await client.db().dropDatabase();
  await client.close();
  await closePool();
}

main().catch((err) => { console.error('\nthroughput run crashed:', err); process.exit(1); });
