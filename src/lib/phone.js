/**
 * The one and only phone normaliser.
 *
 * This lives on its own because it has two callers that MUST agree: the CSV
 * import, which decides what gets stored, and login, which decides what
 * matches. If those two ever normalise differently, a number imported in one
 * form cannot be used to sign in — and the failure is silent, looks like
 * "the OTP never arrived", and would be miserable to diagnose from a
 * support call.
 *
 * Two implementations of this function is a bug waiting to happen. There is
 * one.
 */

/**
 * Indian mobile numbers: ten digits starting 6–9.
 * Accepts every form a real payroll export contains and returns the bare
 * ten digits, or null if it is not a valid Indian mobile number.
 */
export function normalisePhone(raw) {
  const digits = String(raw ?? '').replace(/[^\d]/g, '');

  // Strip leading zeros FIRST. Real payroll exports contain "09876543210",
  // "+91 98765 43210" and "091-9876543210" — the last is a leading zero AND
  // a country code, so the order of these two steps matters.
  let local = digits.replace(/^0+/, '');
  if (local.length === 12 && local.startsWith('91')) local = local.slice(2);

  if (!/^[6-9]\d{9}$/.test(local)) return null;
  return local;
}
