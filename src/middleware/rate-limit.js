/**
 * Rate limits on the unauthenticated endpoints.
 *
 * Everything else in the API is behind requireAuth, which re-reads the
 * employee on every request. The OTP endpoints are the only doors an
 * anonymous caller can knock on, so they are the only ones limited here.
 *
 * Keyed by IP, deliberately NOT by employee_id. Limiting per account would
 * let anyone lock a named employee out of their own attendance simply by
 * spamming their ID — turning a protection into a denial-of-service weapon.
 * Per-account abuse is already bounded elsewhere: a new code retires the
 * previous one, and otp_codes.attempts caps guesses at config.otp.maxAttempts.
 *
 * ⚠ THE SAME TRAP, ONE LEVEL UP. If every caller resolves to the SAME key the
 *   limiter stops protecting anyone and starts locking out everyone — twenty
 *   requests from one attacker and no employee can sign in for the rest of the
 *   window. That is not hypothetical: on Netlify `req.ip` is undefined,
 *   express-rate-limit fell back to a single shared key, and 25 requests from
 *   25 different addresses were counted as one caller. Whatever key is chosen
 *   below, it must distinguish callers or it must not exist.
 */

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { config } from '../config.js';

/**
 * Netlify's edge sets this header and overwrites anything the caller sent, so
 * on Netlify it is trustworthy — which `x-forwarded-for` is not.
 *
 * It is read ONLY when we are actually running on Netlify. On any other host
 * nothing strips it, so a caller could send `x-nf-client-connection-ip` with a
 * fresh value on every request and walk straight past the limit.
 */
const NETLIFY_CLIENT_IP_HEADER = 'x-nf-client-connection-ip';
const onNetlify = process.env.NETLIFY === 'true';

function clientIp(req) {
  if (onNetlify) {
    const supplied = req.headers[NETLIFY_CLIENT_IP_HEADER];
    if (typeof supplied === 'string' && supplied.trim()) return supplied.trim();
  }

  // Express's own answer. Correct when the app is reached directly, and
  // correct behind a reverse proxy once that deployment sets `trust proxy` —
  // still a provisioning checklist item for a self-hosted install, because
  // without it every request appears to come from the proxy.
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

// Warn once per process rather than once per request: on a flood the warning
// would otherwise become the flood.
let warnedAboutMissingIp = false;
let unidentified = 0;

function keyGenerator(req) {
  const ip = clientIp(req);

  // ipKeyGenerator collapses an IPv6 address to its /56 subnet. A single
  // client is routinely handed a whole /64, so keying on the full address
  // would let one machine rotate through addresses it already owns.
  if (ip) return ipKeyGenerator(ip, 56);

  if (!warnedAboutMissingIp) {
    warnedAboutMissingIp = true;
    console.error(
      '[rate-limit] Cannot determine the client IP, so the OTP endpoints are ' +
        'NOT rate limited. Every request is being given its own key on purpose: ' +
        'one shared key would lock every employee out of sign-in as soon as any ' +
        'single caller passed the limit. Set `trust proxy`, or run somewhere ' +
        'that reports the caller.',
    );
  }

  // A key nothing else will collide with. This lets the request through
  // unlimited, which is the lesser of the two failures available here: an
  // unlimited OTP endpoint costs SMS, a shared bucket costs every employee
  // their attendance for fifteen minutes.
  unidentified += 1;
  return `unidentified:${unidentified}`;
}

const shared = {
  windowMs: config.rateLimit.windowMinutes * 60_000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  // Answer in our own error shape, and say what to do — never just "429".
  handler: (_req, res) =>
    res.status(429).json({
      error: 'TOO_MANY_REQUESTS',
      message: 'Too many attempts. Wait a few minutes and try again.',
    }),
};

/** Asking for a code. The expensive one — every request may send an SMS. */
export const otpRequestLimiter = rateLimit({
  ...shared,
  limit: config.rateLimit.otpRequest,
});

/** Submitting a code. Guess-count per code is capped in the database too. */
export const otpVerifyLimiter = rateLimit({
  ...shared,
  limit: config.rateLimit.otpVerify,
});
