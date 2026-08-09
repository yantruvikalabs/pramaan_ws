/**
 * Sending the one-time code.
 *
 * O-5 (notification transport) is OPEN. Nothing is provisioned yet, and in
 * India transactional SMS additionally needs TRAI DLT registration of the
 * sender ID and of every message template before any provider will deliver —
 * a lead time measured in weeks, which is exactly why the build plan starts
 * it in Phase 1 rather than in Phase 5 where it is first needed.
 *
 * Until then 'log' prints the code to the server log.
 * config.assertProductionSafe() refuses to start production in that mode, so
 * this cannot reach a real deployment by accident.
 *
 * When a provider is chosen, only send() changes. Nothing above it knows how
 * a code travels.
 */

import { config } from '../config.js';

/**
 * @returns {{ delivered: boolean, devCode?: string }}
 *   devCode is returned ONLY in log mode, so development and the gate script
 *   can complete a login. It is never present in production.
 */
export async function sendCode({ channel, destination, code, employeeId, log }) {
  if (config.otp.deliver === 'log') {
    // The destination is masked even here. Server logs get copied into
    // tickets and pasted into chats; a phone number that never enters the
    // log cannot leak from one.
    log?.info(
      { employeeId, channel, destination },
      `OTP for ${employeeId} via ${channel}: ${code}`,
    );
    return { delivered: true, devCode: code };
  }

  throw new Error(
    `OTP delivery mode "${config.otp.deliver}" is not implemented — O-5 is still open`,
  );
}
