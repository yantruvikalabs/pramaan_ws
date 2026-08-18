/**
 * Working out who is trying to sign in.
 *
 * The user types ONE thing into ONE box. No tabs, no radio buttons, no
 * "sign in with" menu — a cleaner standing at a gate at 6am should not have
 * to classify their own identifier before they can start.
 *
 *   contains "@"        -> email
 *   digits only         -> phone
 *   anything else       -> employee ID
 *
 * Employee ID is kept as an accepted identifier deliberately. It is the only
 * one guaranteed to exist and be unique for every single person, and it is
 * what a supervisor reaches for when helping somebody whose number changed.
 */

import { OTP_CHANNEL } from './vocabulary.js';
import { normalisePhone } from './phone.js';

/**
 * Deliberately permissive. This is not the place to argue with a valid but
 * unusual address — the code goes to the mailbox, and a wrong address simply
 * never produces a working code.
 */
export function normaliseEmail(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > 255) return null;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value) ? value : null;
}

/**
 * Classify what the user typed.
 * Returns { kind: 'EMAIL'|'PHONE'|'EMPLOYEE_ID', value } or null.
 */
export function classifyIdentifier(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return null;

  if (trimmed.includes('@')) {
    const value = normaliseEmail(trimmed);
    return value ? { kind: 'EMAIL', value } : null;
  }

  // Only digits and the punctuation people put in phone numbers. Uses the
  // SAME normaliser as the CSV import — see lib/phone.js for why that
  // matters more than it looks.
  if (/^[+0-9\s\-().]+$/.test(trimmed)) {
    const value = normalisePhone(trimmed);
    return value ? { kind: 'PHONE', value } : null;
  }

  return { kind: 'EMPLOYEE_ID', value: trimmed };
}

/** The WHERE clause for each kind. Email is stored lowercased. */
export function lookupFor(identifier) {
  switch (identifier.kind) {
    case 'EMAIL':
      return { column: 'email', value: identifier.value, channel: OTP_CHANNEL.EMAIL };
    case 'PHONE':
      return { column: 'phone', value: identifier.value, channel: OTP_CHANNEL.SMS };
    default:
      return { column: 'employee_id', value: identifier.value, channel: OTP_CHANNEL.SMS };
  }
}

/**
 * What we tell the user we sent the code to.
 *
 * Masked, always. An unauthenticated caller must not learn a phone number or
 * an email address from a login screen — that would turn the login box into
 * a contact-details lookup for anyone who knows an employee ID.
 */
export function maskDestination(channel, phone, email) {
  if (channel === 'EMAIL' && email) {
    const [user, domain] = email.split('@');
    const head = user.slice(0, 2);
    return `${head}${'•'.repeat(Math.max(1, user.length - 2))}@${domain}`;
  }
  if (phone && phone.length >= 4) {
    return `${'•'.repeat(phone.length - 4)}${phone.slice(-4)}`;
  }
  return null;
}
