/**
 * Publishing chain heads — FRD BR-EVD-21.
 *
 * This is the only thing that makes server-side signing mean anything.
 *
 * The chain is signed by a key we hold, on a server we run. That protects it
 * against everyone EXCEPT us. A head handed to somebody else **before**
 * anyone would want to rewrite history is what closes that hole: an altered
 * chain no longer matches a head already in the contractor's possession.
 *
 * ⚠ Writing a head into the same database as the chain protects against
 * nobody — anyone who can rewrite one can rewrite the other. That was the
 * first version of this and it was wrong. A head must leave this database,
 * and ideally this machine.
 *
 * Three sinks, weakest to strongest:
 *
 *   1. `index`    a row in MySQL. An INDEX of what was published, not the
 *                 publication. Worth having so an admin can see the history;
 *                 worth nothing as evidence.
 *   2. `file`     an append-only JSONL file outside the database, at a path
 *                 that should be on different storage and in the backup set.
 *                 Survives a compromised database. Does not survive a
 *                 compromised machine.
 *   3. `webhook`  POSTed to somewhere the CONTRACTOR controls. This is the
 *                 real one. Everything above is preparation for it.
 *
 * A deployment that configures only 1 and 2 has an audit trail, not
 * evidence. publishHead() says so in its result rather than pretending.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { sign } from './signing.js';
import { query } from '../db.js';
import { config } from '../config.js';

/**
 * @returns {{seq, hash, published_at, signature, sinks: {index, file, webhook}, offsite: boolean}}
 *   `offsite` is the honest answer to "is this evidence yet?".
 */
export async function publishHead(head, destination) {
  const attestation = {
    seq: head.seq,
    hash: head.hash,
    published_at: new Date().toISOString(),
    destination,
  };
  const signature = sign(Buffer.from(JSON.stringify(attestation), 'utf8'));
  const record = { ...attestation, signature };

  const sinks = { index: false, file: false, webhook: false };

  // 1 — the index. Never the publication.
  try {
    await query(
      'INSERT INTO published_heads (seq, hash, signature, destination) VALUES (?,?,?,?)',
      [head.seq, head.hash, signature, destination],
    );
    sinks.index = true;
  } catch {
    // A failed index must not stop a real publication.
  }

  // 2 — outside the database.
  if (config.chain.headsFile) {
    try {
      await mkdir(dirname(config.chain.headsFile), { recursive: true });
      await appendFile(config.chain.headsFile, `${JSON.stringify(record)}\n`, 'utf8');
      sinks.file = true;
    } catch { /* reported below, never thrown */ }
  }

  // 3 — outside the machine. The only sink that is actually evidence.
  if (config.chain.headsWebhook) {
    try {
      const res = await fetch(config.chain.headsWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(10_000),
      });
      sinks.webhook = res.ok;
    } catch { /* reported below, never thrown */ }
  }

  return { ...record, sinks, offsite: sinks.webhook };
}

/** Read back what was published to the file sink, for the verifier. */
export async function publishedHeadsFromFile() {
  if (!config.chain.headsFile || !existsSync(config.chain.headsFile)) return [];
  const text = await readFile(config.chain.headsFile, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Is this deployment's integrity story real, or decorative?
 *
 * Surfaced deliberately rather than buried: a contractor being told their
 * records are verifiable, when no head has ever left this machine, is the
 * kind of claim that falls apart in the one conversation it matters.
 */
export function publishingPosture() {
  if (config.chain.headsWebhook) {
    return {
      level: 'OFFSITE',
      message: 'Heads are sent to a destination outside this server.',
    };
  }
  if (config.chain.headsFile) {
    return {
      level: 'OFF_DATABASE',
      message:
        'Heads are written outside the database but stay on this machine. ' +
        'A compromise of the machine defeats this. Configure CHAIN_HEADS_WEBHOOK.',
    };
  }
  return {
    level: 'NONE',
    message:
      'Heads exist only in the database that holds the chain. This protects ' +
      'against nobody. Do not describe these records as independently verifiable.',
  };
}
