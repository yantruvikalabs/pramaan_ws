/**
 * Canonical serialisation — FRD BR-EVD-6a. ⚠ FROZEN.
 *
 * Every verifier must reproduce byte-for-byte identical output from the same
 * event, forever, in whatever language it is written in. If this function
 * ever changes its output for an input it has already seen, every record
 * signed before the change stops verifying.
 *
 * So: it is versioned. `CANON_VERSION` is stored on every event. A change
 * means a NEW version, applied only to new events, with the old one kept
 * here and still callable. Editing v1 in place is never correct.
 *
 * The rules, chosen to be trivially reimplementable in a browser:
 *
 *   1. Object keys sorted by Unicode code point, ascending.
 *   2. No insignificant whitespace.
 *   3. Keys whose value is null or undefined are OMITTED, not emitted as
 *      null — so a field added later with no value cannot change the bytes
 *      of an event that never had it.
 *   4. Numbers must be finite integers. Floats are refused outright:
 *      JavaScript, Python and Java do not agree on how to print them, and
 *      a verifier that disagrees by one digit is a verifier that fails.
 *      This is why coordinates never enter the envelope as numbers.
 *   5. Strings are emitted with JSON.stringify's escaping, which is
 *      well-specified and identical across implementations.
 *   6. Arrays keep their order. Order is data.
 */

export const CANON_VERSION = 1;

function canon(value, path) {
  if (value === null || value === undefined) {
    throw new Error(`canonical: null at ${path} should have been omitted`);
  }

  const t = typeof value;

  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(
        `canonical: ${path} is ${value} — only finite integers may be signed. ` +
        'Fractional values must be strings, so that every language prints them identically.',
      );
    }
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v, i) => canon(v, `${path}[${i}]`)).join(',')}]`;
  }

  if (t === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== null && value[k] !== undefined)
      .sort();   // default sort is by UTF-16 code unit, which is what we want
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(value[k], `${path}.${k}`)}`).join(',')}}`;
  }

  throw new Error(`canonical: ${path} is a ${t}, which cannot be signed`);
}

/**
 * The exact bytes that get hashed and signed.
 * @returns {Buffer} UTF-8
 */
export function canonicalBytes(event) {
  return Buffer.from(canon(event, '$'), 'utf8');
}

/** The same thing as a string, for logging and for the verifier page. */
export function canonicalString(event) {
  return canon(event, '$');
}
