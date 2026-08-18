/**
 * The chain's signing key — FRD BR-EVD-8.
 *
 * ECDSA P-256, held on disk OUTSIDE the application database, so that
 * compromising the database alone cannot produce a valid new chain.
 *
 * P-256 rather than Ed25519 for one reason: the offline verifier is a static
 * page with no dependencies, and browser WebCrypto supports P-256 everywhere
 * and Ed25519 unevenly. A verifier a client cannot run is not a verifier.
 *
 * ⚠ What this key does NOT do, so nobody mistakes it later: it proves the
 * chain has not been altered since the server accepted each record. It does
 * not prove the record was true when it arrived, and it does not protect
 * against whoever holds this key — which is us. That is what publishing
 * chain heads is for (BR-EVD-21).
 */

import { createSign, createVerify, generateKeyPairSync, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

let cached = null;

/**
 * Load the key, generating one on first run in development.
 *
 * Production never generates: a key that appears by itself is a key nobody
 * backed up, and losing it means no new record can ever be appended to this
 * chain. assertProductionSafe() refuses to start without CHAIN_KEY_PATH set.
 *
 * CHAIN_PRIVATE_KEY_PEM takes precedence over the file, and exists for hosts with
 * no durable disk. On a serverless platform the file path is worse than
 * useless: each instance finds nothing there, generates its own key, and the
 * chain ends up signed by as many keys as the platform happened to start
 * processes — every one of them verifying against nothing. One key supplied
 * as configuration is the only correct answer on such a host.
 */
export function signingKey() {
  if (cached) return cached;

  const supplied = config.chain.privateKeyPem;
  if (supplied) {
    // Accept the raw PEM and base64 alike. Which of the two a dashboard
    // mangles is not knowable in advance: some strip the newlines a PEM needs,
    // some pass `\n` through literally, and base64 survives all of them.
    const pem = supplied.includes('-----BEGIN')
      ? supplied.replaceAll('\\n', '\n')
      : Buffer.from(supplied, 'base64').toString('utf8');
    return (cached = derive(pem));
  }

  const path = config.chain.keyPath;

  if (!existsSync(path)) {
    if (config.env === 'production') {
      throw new Error(
        `Chain signing key not found at ${path}. It must be provisioned and ` +
        'backed up before the server starts — it cannot be regenerated.',
      );
    }
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  return (cached = derive(readFileSync(path, 'utf8')));
}

/** Everything the rest of the codebase needs, from one PEM. */
function derive(pem) {
  const publicKey = createPublicKey(pem);
  return {
    privatePem: pem,
    publicKey,
    /** SPKI DER, base64 — what a verifier imports into WebCrypto. */
    publicSpkiB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** Detached signature over the canonical bytes. */
export function sign(bytes) {
  const s = createSign('SHA256');
  s.update(bytes);
  s.end();
  return `ecdsa-p256:${s.sign(signingKey().privatePem, 'base64')}`;
}

export function verify(bytes, signature) {
  if (typeof signature !== 'string' || !signature.startsWith('ecdsa-p256:')) return false;
  const v = createVerify('SHA256');
  v.update(bytes);
  v.end();
  try {
    return v.verify(signingKey().publicKey, signature.slice('ecdsa-p256:'.length), 'base64');
  } catch {
    return false;
  }
}

/** Handed to anyone verifying an export. Safe to publish — it is public. */
export function publicKeyForVerifiers() {
  return {
    algorithm: 'ECDSA',
    curve: 'P-256',
    hash: 'SHA-256',
    spki_base64: signingKey().publicSpkiB64,
  };
}
