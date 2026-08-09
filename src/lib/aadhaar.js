/**
 * Aadhaar rejection — FRD BR-MST-7/8/9.
 *
 * "No Aadhaar number is captured, stored, transmitted, logged or displayed
 *  by any component."
 *
 * This is ENFORCED, not merely stated. Any value that looks like a real
 * Aadhaar number is refused at the boundary rather than stored and flagged.
 *
 * A 12-digit number alone is not enough to reject on — employee IDs, phone
 * concatenations and reference numbers can be 12 digits. Aadhaar carries a
 * Verhoeff check digit, so we reject only values that actually pass it. That
 * keeps false positives near zero while catching every genuine Aadhaar.
 *
 * IMPORTANT: nothing in this file may log the offending value. Reporting a
 * rejection must never echo the number back — that would put an Aadhaar in
 * the log, which is the exact thing the rule forbids.
 */

// Verhoeff — dihedral group D5 multiplication table.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

// Verhoeff — permutation table.
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** True when a 12-digit string satisfies the Verhoeff checksum. */
export function verhoeffValid(digits) {
  if (!/^\d{12}$/.test(digits)) return false;
  let c = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    const digit = Number(reversed[i]);
    c = D[c][P[i % 8][digit]];
  }
  return c === 0;
}

/**
 * True when `value` looks like a real Aadhaar number.
 *
 * Aadhaar numbers never begin with 0 or 1, and carry a Verhoeff check digit.
 * Separators (spaces, hyphens) are stripped first, because "1234 5678 9012"
 * is how people actually type it.
 */
export function looksLikeAadhaar(value) {
  if (value === null || value === undefined) return false;
  const raw = String(value);

  // Strip the separators people use, but only those — do not strip letters,
  // or "ABC123456789012" would be misread as a bare number.
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(digits)) return false;
  if (digits[0] === '0' || digits[0] === '1') return false;

  return verhoeffValid(digits);
}

/**
 * Scan an object's values (recursively) for anything Aadhaar-shaped.
 * Returns the list of FIELD NAMES that offended — never the values.
 */
export function findAadhaarFields(obj, prefix = '') {
  const hits = [];
  if (obj === null || typeof obj !== 'object') return hits;

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      hits.push(...findAadhaarFields(value, path));
    } else if (looksLikeAadhaar(value)) {
      hits.push(path);
    }
  }
  return hits;
}

/** Field names that must never exist, whatever they contain. FRD BR-MST-9. */
export const BANNED_FIELD_NAMES = Object.freeze(['aadhaar', 'aadhar', 'uid']);

/** Returns offending key names found in an object, ignoring case and separators. */
export function findBannedFieldNames(obj) {
  if (obj === null || typeof obj !== 'object') return [];
  return Object.keys(obj).filter((k) => {
    const norm = k.toLowerCase().replace(/[^a-z]/g, '');
    return BANNED_FIELD_NAMES.includes(norm);
  });
}
