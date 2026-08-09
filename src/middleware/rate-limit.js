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
 * NOTE for deployment: behind a reverse proxy the app must set
 * `trust proxy` or every request appears to come from the proxy's IP and the
 * limit becomes global. Single-tenant deployment (FRD NFR-6) means one
 * server per contractor, so this is a provisioning checklist item.
 */

import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

const shared = {
  windowMs: config.rateLimit.windowMinutes * 60_000,
  standardHeaders: true,
  legacyHeaders: false,
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
