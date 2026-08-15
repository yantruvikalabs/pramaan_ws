/**
 * verifyChain's failure branches — including the one MySQL made impossible.
 *
 * Four things can be wrong with a chain and they mean different things: a gap
 * means a record was removed, a broken link means one was altered, a bad hash
 * means its content changed, a bad signature means it was never ours.
 *
 * A FIFTH became possible when the store changed. `PRIMARY KEY (seq)` made two
 * events at one position unrepresentable, so there was no branch for it. Any
 * store without that guarantee can fork, and a fork must not be reported as a
 * deletion — "a record is missing" sends you looking for something that was
 * never removed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyEvents, envelopeOf, GENESIS_HASH } from '../src/lib/chain.js';
import { canonicalBytes, CANON_VERSION } from '../src/lib/canonical.js';
import { sign } from '../src/lib/signing.js';

const sha256 = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/**
 * A genuine fork: a SECOND, properly signed event claiming the same seq and
 * the same prev_hash as `original`.
 *
 * It has to be signed correctly, or it is not a fork — it is a forgery, and
 * ALTERED or BAD_SIGNATURE fires first and the duplicate branch is never
 * reached. That is exactly what happened to the first version of these tests:
 * copying an event and editing its `event_id` changed a SIGNED field, so the
 * copy failed the hash check before anything looked at its seq.
 *
 * The real hazard is two internally-valid events at one position, each
 * verifying perfectly on its own. This builds that.
 */
function forkOf(original, payload) {
  const e = { ...original, payload, event_id: `ffffffff-0000-4000-8000-${String(original.seq).padStart(12, '0')}` };
  const bytes = canonicalBytes(envelopeOf(e));
  e.hash = sha256(bytes);
  e.signature = sign(bytes);
  return e;
}

/** Build a genuinely signed, correctly linked chain of `n` events. */
function makeChain(n) {
  const events = [];
  let prev = GENESIS_HASH;

  for (let i = 1; i <= n; i += 1) {
    const e = {
      seq: i,
      event_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      type: 'AttendancePunch',
      subject_ref: null,
      device_ref: null,
      session_ref: null,
      location_ref: null,
      payload: { kind: 'IN', n: i },
      captured_at: null,
      received_at: new Date(1786000000000 + i * 1000).toISOString(),
      device_time: null,
      uptime_ms: null,
      prev_hash: prev,
      canon_v: CANON_VERSION,
    };
    const bytes = canonicalBytes(envelopeOf(e));
    e.hash = sha256(bytes);
    e.signature = sign(bytes);
    events.push(e);
    prev = e.hash;
  }
  return events;
}

test('verifyEvents — a sound chain verifies', () => {
  const r = verifyEvents(makeChain(5));
  assert.equal(r.ok, true);
  assert.equal(r.checked, 5);
  assert.equal(r.from, 1);
  assert.equal(r.to, 5);
});

test('verifyEvents — an empty range is not a failure', () => {
  const r = verifyEvents([], 1);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 0);
});

test('verifyEvents — a removed record is a GAP', () => {
  const chain = makeChain(5);
  chain.splice(2, 1);                                   // remove seq 3

  const r = verifyEvents(chain);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'GAP');
  assert.equal(r.at_seq, 4);
  assert.match(r.detail, /a record is missing/);
});

test('verifyEvents — a FORK is DUPLICATE_SEQ, not GAP', () => {
  // The regression this file exists for. Two events at seq 3, each internally
  // valid. Before the duplicate branch, the second one tripped the gap test
  // and the chain reported "expected seq 4, found 3 — a record is missing",
  // which is the opposite of what happened: nothing was removed, something
  // was added twice.
  const chain = makeChain(5);
  chain.splice(3, 0, forkOf(chain[2], { kind: 'OUT', n: 3 }));   // 1,2,3,3',4,5

  const r = verifyEvents(chain);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'DUPLICATE_SEQ',
    'a fork must not be reported as a deletion');
  assert.equal(r.at_seq, 3);
  assert.match(r.detail, /forked/);
  assert.doesNotMatch(r.detail, /a record is missing/,
    'it must not use the GAP wording — nothing was removed');
});

test('verifyEvents — a relinked event is a BROKEN_LINK', () => {
  const chain = makeChain(5);
  chain[3].prev_hash = GENESIS_HASH;                    // seq 4 points nowhere useful

  const r = verifyEvents(chain);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'BROKEN_LINK');
  assert.equal(r.at_seq, 4);
});

test('verifyEvents — edited content is ALTERED', () => {
  const chain = makeChain(5);
  chain[2].payload = { kind: 'OUT', n: 3 };             // content changed, hash not

  const r = verifyEvents(chain);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ALTERED');
  assert.equal(r.at_seq, 3);
});

test('verifyEvents — a foreign signature is BAD_SIGNATURE', () => {
  const chain = makeChain(5);
  // Re-hash so the content still matches its hash: only the signature is
  // wrong. Otherwise ALTERED fires first and this branch is never reached.
  const e = chain[2];
  e.payload = { kind: 'OUT', n: 3 };
  const bytes = canonicalBytes(envelopeOf(e));
  e.hash = sha256(bytes);
  chain[3].prev_hash = e.hash;                          // keep the links intact
  e.signature = chain[0].signature;                     // a real signature, wrong event

  const r = verifyEvents(chain);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'BAD_SIGNATURE');
  assert.equal(r.at_seq, 3);
});

test('verifyEvents — the first failure wins, and duplicates are seen first', () => {
  // A chain with a duplicate AND a later gap must report the duplicate: it
  // comes first in sequence order, and it is also the more specific diagnosis.
  const chain = makeChain(6);
  chain.splice(3, 0, forkOf(chain[2], { kind: 'OUT', n: 3 }));   // 1,2,3,3',4,5,6
  chain.splice(5, 1);                                            // 1,2,3,3',5,6

  const r = verifyEvents(chain);
  assert.equal(r.reason, 'DUPLICATE_SEQ');
  assert.equal(r.at_seq, 3, 'the duplicate at seq 3 precedes the gap at seq 4');
});

test('verifyEvents — a range not starting at 1 does not demand the genesis hash', () => {
  // readRange(fromSeq) can start mid-chain. The first event's prev_hash then
  // refers to an event outside the range and cannot be checked.
  const chain = makeChain(5).slice(2);                  // seq 3,4,5
  const r = verifyEvents(chain, 3);
  assert.equal(r.ok, true);
  assert.equal(r.from, 3);
});
