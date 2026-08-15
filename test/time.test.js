/**
 * Reading stored timestamps — the J1 regression suite.
 *
 * The bug these exist for: three call sites built `new Date(`${value}Z`)`,
 * which is correct for a MySQL naive string and silently wrong for a Date
 * object, by exactly the server's UTC offset. It could not be caught by the
 * old tests because (a) nothing fed those functions a Date, and (b) on a UTC
 * runner the offset is zero and the wrong expression gives the right answer.
 *
 * So the central assertion here is a CROSS-REPRESENTATION one: the same
 * instant, written the way MySQL returns it and the way MongoDB returns it,
 * must read as the same number. Run this under TZ=Asia/Kolkata as well as
 * TZ=UTC — see `npm run test:tz`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { epochMs, isPast, millisSince } from '../src/lib/time.js';

const INSTANT = Date.UTC(2026, 7, 3, 6, 28, 15, 638);        // 2026-08-03T06:28:15.638Z

test('epochMs — the same instant reads identically in every representation', async (t) => {
  const forms = {
    'MySQL DATETIME(3), space separator': '2026-08-03 06:28:15.638',
    'MySQL DATETIME(3), T separator': '2026-08-03T06:28:15.638',
    'ISO-8601 with Z': '2026-08-03T06:28:15.638Z',
    'a BSON/JS Date': new Date(INSTANT),
    'epoch milliseconds': INSTANT,
  };

  for (const [name, value] of Object.entries(forms)) {
    await t.test(name, () => {
      assert.equal(epochMs(value), INSTANT);
    });
  }
});

test('epochMs — a naive string is UTC, never the server timezone', () => {
  // If this ever reads as local time, every stored timestamp silently shifts
  // by the offset of whichever machine is running, and the chain's canonical
  // form stops meaning one thing.
  assert.equal(epochMs('2026-08-03 06:28:15.638'), INSTANT);
  assert.equal(epochMs('2026-08-03 00:00:00.000'), Date.UTC(2026, 7, 3, 0, 0, 0, 0));
});

test('epochMs — an exact second, with and without the trailing .000', () => {
  const exact = Date.UTC(2026, 7, 3, 6, 28, 15, 0);
  // MySQL trims trailing fractional zeros; both forms must agree. This is the
  // shape that caused the one-in-a-thousand ALTERED bug in the chain.
  assert.equal(epochMs('2026-08-03 06:28:15.000'), exact);
  assert.equal(epochMs('2026-08-03 06:28:15'), exact);
  assert.equal(epochMs(new Date(exact)), exact);
});

test('epochMs — REFUSES what it cannot read, rather than returning NaN', async (t) => {
  // This is the point of the whole module. `NaN < Date.now()` is false, so a
  // silent NaN answers "not expired" to every question — an OTP that never
  // expires and a session that never idles out, with no error anywhere.
  const bad = {
    null: null,
    undefined: undefined,
    'an Invalid Date': new Date('nonsense'),
    'a non-date string': 'yesterday',
    'an empty string': '',
    'an object': {},
    NaN,
  };

  for (const [name, value] of Object.entries(bad)) {
    await t.test(name, () => {
      assert.throws(() => epochMs(value, 'probe'), TypeError);
    });
  }
});

test('epochMs — the exact J1 failure mode is gone', () => {
  // The old expression, reproduced. It was wrong in TWO independent ways, and
  // both are asserted so a future "simplification" cannot quietly restore
  // either one.
  const d = new Date(INSTANT);
  const oldWay = new Date(`${d}Z`).getTime();
  const offset = -new Date().getTimezoneOffset() * 60_000;
  const msComponent = INSTANT % 1000;                       // 638

  assert.equal(epochMs(d), INSTANT, 'epochMs must read the true instant');

  // (2) Date.prototype.toString() has no milliseconds field, so interpolating
  //     a Date into a string discarded sub-second precision as well. Found by
  //     this test: the drift came out 638 ms short of the offset.
  assert.ok(!/\.\d{3}/.test(String(d)), 'Date.toString() carries no milliseconds');
  assert.equal(msComponent, 638);

  if (offset !== 0) {
    // (1) The timezone shift, minus the milliseconds that were dropped.
    assert.notEqual(oldWay, INSTANT,
      'the old expression should be wrong here — if it is not, this test is not exercising J1');
    assert.equal(oldWay - INSTANT, offset - msComponent,
      'the old drift is the UTC offset less the discarded milliseconds');
  } else {
    // On a UTC runner only the millisecond loss survives — which is precisely
    // why this bug shipped green. The offset error is invisible here.
    assert.equal(oldWay - INSTANT, -msComponent,
      'under UTC the offset error vanishes and only the dropped ms remain');
  }
});

test('isPast — works on both a string and a Date', () => {
  const past = '2020-01-01 00:00:00.000';
  const future = new Date(Date.now() + 600_000);

  assert.equal(isPast(past, 'past'), true);
  assert.equal(isPast(future, 'future'), false);
  assert.equal(isPast(new Date('2020-01-01T00:00:00.000Z'), 'past as Date'), true);
});

test('isPast — a 10-minute OTP expires at 10 minutes, not 5h40m', () => {
  // The concrete consequence of J1: with the old expression and an IST server,
  // a code issued 30 minutes ago was still accepted.
  const issued = Date.now() - 30 * 60_000;
  const expiresAt = new Date(issued + 10 * 60_000);

  assert.equal(isPast(expiresAt, 'otp.expires_at'), true,
    'a code that expired 20 minutes ago must be rejected');
});

test('millisSince — measures elapsed time from either representation', () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0, 0);
  const twoHoursAgo = Date.UTC(2026, 7, 3, 10, 0, 0, 0);

  assert.equal(millisSince(new Date(twoHoursAgo), 'last_seen_at', now), 2 * 3_600_000);
  assert.equal(millisSince('2026-08-03 10:00:00.000', 'last_seen_at', now), 2 * 3_600_000);
});

test('millisSince — a web session idles out at the configured hour, not 5.5 hours later', () => {
  const now = Date.now();
  const idleHours = 12;
  const lastSeen = new Date(now - (idleHours + 1) * 3_600_000);

  assert.ok(millisSince(lastSeen, 'last_seen_at', now) > idleHours * 3_600_000,
    'a session idle for longer than the limit must read as expired');
});
