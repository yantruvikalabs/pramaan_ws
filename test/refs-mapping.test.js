/**
 * Store-shape independence for location fixes.
 *
 * These exist because of one comparison. `is_mock` was read as `r.is_mock === 1`,
 * which is correct against MySQL's TINYINT(1) and silently WRONG against a BSON
 * boolean — `true === 1` is false. The consequence is not a crash: it is every
 * spoofed GPS fix reading back as genuine, with no error, defeating the control
 * FRD §14.6 relies on.
 *
 * So the assertion is deliberately cross-representation: the same fix, shaped
 * the way each store returns it, must produce one identical result.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { toLocation } from '../src/lib/refs.js';

test('toLocation — a mocked fix reads as mocked from either store', async (t) => {
  const shapes = {
    // mysql2 with DECIMAL(9,6) → strings; TINYINT(1) → number
    'MySQL row': { lat: '12.971599', lon: '77.594566', accuracy_m: 12, is_mock: 1 },
    // BSON Double → number; BSON Boolean → true
    'Mongo document': { lat: 12.971599, lon: 77.594566, accuracy_m: 12, is_mock: true },
  };

  for (const [name, row] of Object.entries(shapes)) {
    await t.test(name, () => {
      const loc = toLocation(row);
      assert.equal(loc.is_mock, true, 'a mocked fix MUST read as mocked');
      assert.equal(loc.lat, 12.971599);
      assert.equal(loc.lon, 77.594566);
      assert.equal(loc.accuracy_m, 12);
    });
  }
});

test('toLocation — a genuine fix reads as genuine from either store', async (t) => {
  const shapes = {
    'MySQL row': { lat: '12.9', lon: '77.5', accuracy_m: 8, is_mock: 0 },
    'Mongo document': { lat: 12.9, lon: 77.5, accuracy_m: 8, is_mock: false },
  };

  for (const [name, row] of Object.entries(shapes)) {
    await t.test(name, () => {
      assert.equal(toLocation(row).is_mock, false);
    });
  }
});

test('toLocation — the two store shapes produce IDENTICAL output', () => {
  // The assertion that actually catches a divergence: not that each is
  // individually plausible, but that they agree.
  const mysql = toLocation({ lat: '12.971599', lon: '77.594566', accuracy_m: 12, is_mock: 1 });
  const mongo = toLocation({ lat: 12.971599, lon: 77.594566, accuracy_m: 12, is_mock: true });
  assert.deepEqual(mysql, mongo);
});

test('toLocation — the old comparison would have failed this', () => {
  // Kept as a live demonstration rather than a comment: if someone reverts to
  // `=== 1`, this documents exactly what breaks and why it is silent.
  const mongoRow = { lat: 1, lon: 2, accuracy_m: null, is_mock: true };
  assert.equal(mongoRow.is_mock === 1, false, 'true === 1 is false — the silent failure');
  assert.equal(toLocation(mongoRow).is_mock, true, 'Boolean() gets it right');
});

test('toLocation — a missing accuracy is null, never NaN', async (t) => {
  // Number(undefined) is NaN, and NaN flows onward silently. A missing BSON
  // key reads as undefined where MySQL gives null, so both must be handled.
  for (const [name, value] of Object.entries({ 'MySQL null': null, 'missing key': undefined })) {
    await t.test(name, () => {
      const loc = toLocation({ lat: 1, lon: 2, accuracy_m: value, is_mock: 0 });
      assert.equal(loc.accuracy_m, null);
      assert.ok(!Number.isNaN(loc.accuracy_m));
    });
  }
});

test('toLocation — no row is null, not a throw', () => {
  assert.equal(toLocation(undefined), null);
  assert.equal(toLocation(null), null);
});
