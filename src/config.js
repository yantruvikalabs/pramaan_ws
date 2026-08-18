/** Configuration. Single tenant — one contractor, one deployment. FRD NFR-6. */

import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';

/**
 * Paths are resolved against the APPLICATION, never the working directory.
 *
 * This is not tidiness. `./.data/chain-signing-key.pem` resolved against cwd
 * meant the API (started from the repo root) and the gate script (started
 * from apps/api) used two DIFFERENT signing keys — so records signed by one
 * could not be verified against the other, and the only symptom was
 * "signature does not verify", which reads like tampering.
 *
 * In production the same bug is worse: restart the service from a different
 * directory and it silently mints a new key, and every record written before
 * that moment becomes unverifiable forever.
 */
const appRoot = () => {
  if (process.env.NETLIFY || process.env.LAMBDA_TASK_ROOT) return process.cwd();
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
};

const APP_ROOT = appRoot();
const fromApp = (p) => (isAbsolute(p) ? p : resolve(APP_ROOT, p));
const optionalPath = (name, fallback) => {
  const v = process.env[name];
  if (v === '') return null;
  return fromApp(v ?? fallback);
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '0.0.0.0',

  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'pramaan',
    password: process.env.DB_PASSWORD ?? 'pramaan',
    database: process.env.DB_NAME ?? 'pramaan',
    connectionLimit: Number(process.env.DB_POOL ?? 10),
  },

  mongo: {
    // Development defaults to the local single-node replica set on 27018.
    // ⚠ A replica set is REQUIRED, not preferred: the chain appender needs
    //   multi-document transactions, and a standalone mongod has none.
    uri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27018/?replicaSet=rs0',
    database: process.env.MONGODB_DB ?? 'pramaan',
  },

  jwt: {
    // Dev fallback only. Startup refuses to run in production without a real one.
    secret: process.env.JWT_SECRET ?? 'dev-only-do-not-use-in-production',
    // Long, because the token's clock is not what ends a session — the
    // sessions table is. This is only a backstop for a token that somehow
    // outlives its row. FRD: signed in until you sign out.
    expiresIn: process.env.JWT_EXPIRES_IN ?? '365d',
  },

  chain: {
    // OUTSIDE the application database — FRD BR-EVD-8. A compromise of the
    // database alone must not be enough to forge a chain. Development
    // generates one on first run; production refuses to.
    keyPath: fromApp(process.env.CHAIN_KEY_PATH ?? '.data/chain-signing-key.pem'),
    privateKeyPem: process.env.CHAIN_PRIVATE_KEY_PEM ?? null,
    // How many events one upload may carry. A phone that was offline for a
    // week has a few hundred; a request with fifty thousand is not a phone.
    maxBatch: Number(process.env.CHAIN_MAX_BATCH ?? 500),

    // Chain heads — FRD BR-EVD-21, and see lib/heads.js.
    //
    // A head recorded only in the database it protects is worthless. The
    // file sink gets it out of the database; the webhook gets it off the
    // machine and is the only one that is actually evidence.
    headsFile: optionalPath('CHAIN_HEADS_FILE', '.data/published-heads.jsonl'),
    headsWebhook: process.env.CHAIN_HEADS_WEBHOOK ?? null,
  },

  session: {
    // Mobile never expires on idle. A worker must not be logged out standing
    // at a gate at 6am because they did not open the app for a fortnight.
    // Web does, because it is the account that can see all 2,000 employees
    // and the browser may be on a shared office machine.
    webIdleHours: Number(process.env.SESSION_WEB_IDLE_HOURS ?? 12),
  },

  otp: {
    length: 6,
    ttlMinutes: Number(process.env.OTP_TTL_MINUTES ?? 10),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS ?? 5),
    // Development prints the code to the log instead of sending an SMS.
    // O-5 (notification transport) is open; provisioning takes weeks and is
    // started in Phase 1 precisely so Phase 5 is not blocked by it.
    deliver: process.env.OTP_DELIVERY ?? 'log',
  },

  rateLimit: {
    windowMinutes: Number(process.env.RATE_LIMIT_WINDOW_MINUTES ?? 15),
    // Generous by design: a genuine user may need a second and third code
    // when SMS is slow, and a shared office IP may carry several people.
    otpRequest: Number(process.env.RATE_LIMIT_OTP_REQUEST ?? 20),
    otpVerify: Number(process.env.RATE_LIMIT_OTP_VERIFY ?? 40),
  },

  branding: {
    // White-label by configuration bundle, never a code fork. FRD NFR-7.
    productName: process.env.BRAND_NAME ?? 'Pramaan',
    contractorName: process.env.CONTRACTOR_NAME ?? 'Demo Contractor',
  },

  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export function assertProductionSafe() {
  if (config.env !== 'production') return;
  if (config.jwt.secret.startsWith('dev-only')) {
    throw new Error('JWT_SECRET must be set in production');
  }
  if (config.otp.deliver === 'log') {
    throw new Error('OTP_DELIVERY must not be "log" in production');
  }
  if (!process.env.CHAIN_HEADS_WEBHOOK) {
    // Refusing to start is deliberate. Without an offsite head this server
    // can rewrite its own history undetectably, and every claim made about
    // these records being verifiable would be false.
    throw new Error(
      'CHAIN_HEADS_WEBHOOK must be set in production — a chain head that never ' +
      'leaves this machine protects against nobody (FRD BR-EVD-21)',
    );
  }
  if (!process.env.CHAIN_KEY_PATH && !process.env.CHAIN_PRIVATE_KEY_PEM) {
    // A key that appears by itself is a key nobody backed up, and losing it
    // means no new record can ever join this chain. Either source is fine —
    // what is refused is neither, which means the server would invent one.
    throw new Error(
      'CHAIN_KEY_PATH or CHAIN_PRIVATE_KEY_PEM must be set in production, and the key backed up',
    );
  }
}
