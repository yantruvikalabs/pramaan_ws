/**
 * Reading a stored timestamp back as a number of milliseconds.
 *
 * ⚠ Why this exists, and why it is not "just call new Date()".
 *
 * Three places used to build a Date by string concatenation:
 *
 *     new Date(`${row.expires_at}Z`)          // auth.js
 *     new Date(`${session.last_seen_at}Z`)    // sessions.js, twice
 *
 * That works only because `db.js` sets `dateStrings: true`, so MySQL hands
 * back a naive string like "2026-08-03 06:28:15.638" and appending "Z" pins it
 * to UTC. The moment a driver returns a real Date object instead — which is
 * what MongoDB does — the same expression interpolates the Date's *display*
 * form:
 *
 *     `${d}Z` → "Thu Aug 13 2026 15:30:00 GMT+0530 (India Standard Time)Z"
 *
 * V8's parser is lenient and accepts it, returning a time shifted by exactly
 * the server's UTC offset. Measured on this codebase: +5h30m in India. A
 * ten-minute one-time code then stays valid for five hours forty, and a web
 * session gets five and a half extra hours against the idle timeout that
 * exists to protect a shared office machine.
 *
 * The shift is the server's own offset, so it is ZERO on a UTC CI runner. The
 * bug passes every test and ships green. That is the whole reason this file
 * exists rather than a one-line fix at each call site.
 *
 * Accepts what any of our stores can return, and REFUSES anything it cannot
 * read. Returning NaN would be worse than throwing: `NaN < Date.now()` is
 * false, so every comparison quietly answers "not expired".
 */

/** MySQL DATETIME(3): "2026-08-03 06:28:15.638", no zone, always UTC here. */
const MYSQL_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;

/**
 * @param {Date|string|number} value
 * @param {string} [what] a label used in the error, so a failure names its source
 * @returns {number} epoch milliseconds
 */
export function epochMs(value, what = 'timestamp') {
  if (value instanceof Date) {
    const t = value.getTime();
    if (Number.isNaN(t)) throw new TypeError(`${what}: Invalid Date`);
    return t;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${what}: ${value} is not a finite number`);
    return value;
  }

  if (typeof value === 'string') {
    // A naive datetime is UTC in this product — db.js pins timezone:'Z' and
    // the chain's canonical form is UTC throughout. Anything else would make
    // the meaning of a stored time depend on where the server happens to run.
    const text = MYSQL_DATETIME.test(value) ? `${value.replace(' ', 'T')}Z` : value;
    const t = Date.parse(text);
    if (Number.isNaN(t)) throw new TypeError(`${what}: cannot parse ${JSON.stringify(value)}`);
    return t;
  }

  throw new TypeError(`${what}: cannot read a ${value === null ? 'null' : typeof value} as a time`);
}

/** Has `value` already passed? */
export const isPast = (value, what, now = Date.now()) => epochMs(value, what) < now;

/** How long ago was `value`, in milliseconds? Negative if it is in the future. */
export const millisSince = (value, what, now = Date.now()) => now - epochMs(value, what);
