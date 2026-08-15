/**
 * Refusing what BSON cannot hold faithfully — BEFORE it is signed.
 *
 * D1 measured this rather than assuming it (docs/mongodb-migration-plan.md §L):
 *
 *     stored  "ok\ud800tail"
 *     read    "ok�tail"
 *
 * BSON silently replaces an unpaired surrogate with U+FFFD. An event carrying
 * one would be signed over the bytes we sent and read back as different bytes
 * forever after — reported as ALTERED, permanently, with no way to repair it,
 * because repairing means editing a signed record.
 *
 * That is the same species as the trailing-`.000` incident in STATUS.md: rare,
 * per-event, permanent, and easy to mistake for flakiness.
 *
 * `payload` is `z.record(z.any())` at the route boundary — unbounded and
 * entirely client-controlled — so this is reachable by anything a phone sends.
 * A submission this refuses becomes a quarantine (BR-EVD-20). It is never
 * rewritten: silently correcting a client's bytes and then signing the
 * correction is the one thing this product must not do.
 */

/**
 * A lone surrogate: half of a UTF-16 pair. Legitimate emoji and Devanagari are
 * complete pairs and pass.
 */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/;

export function assertBsonSafe(value, path = '$') {
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) {
      throw new Error(`unpaired surrogate at ${path} — BSON would replace it with U+FFFD`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) => assertBsonSafe(v, `${path}[${i}]`));
    return;
  }

  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      if (LONE_SURROGATE.test(k)) throw new Error(`unpaired surrogate in key at ${path}.${k}`);
      // Driver v7 round-trips these cleanly, but aggregation, `$merge`, export
      // tooling and mongosh do not agree with the driver here — and a key that
      // survives storage but not an export is worse than one refused up front.
      if (k.includes('.') || k.startsWith('$')) {
        throw new Error(`key ${JSON.stringify(k)} at ${path} uses '.' or a leading '$'`);
      }
      assertBsonSafe(value[k], `${path}.${k}`);
    }
  }
}
