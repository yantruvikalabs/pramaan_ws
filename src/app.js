/**
 * The Express application, built without listening — so tests can start it
 * on an ephemeral port and drive it over real HTTP.
 *
 * Express 5, deliberately: it forwards a rejected promise from an async
 * handler to the error handler on its own, so no route needs a try/catch
 * wrapper and a forgotten one cannot hang a request.
 */

import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import pino from 'pino';
import authRoutes from './routes/auth.js';
import employeeRoutes from './routes/employees.js';
import eventRoutes from './routes/events.js';
import faceEnrolmentRoutes from './routes/face-enrolment.js';
import { unreviewedQuarantine } from './lib/chain.js';
import { publishingPosture } from './lib/heads.js';
import { config } from './config.js';

// A 2,000-row CSV is ~150 KB; 20 MB is ample.
const BODY_LIMIT = '20mb';

export function buildApp(options = {}) {
  const app = express();

  app.disable('x-powered-by');

  if (options.logger !== false) {
    app.use(
      pinoHttp({
        logger: pino({
          level: process.env.LOG_LEVEL ?? 'info',
          // Never log a request body. An employee list is personal data, and
          // a rejected row may contain the very number we refuse to store.
          redact: ['req.headers.authorization', 'req.body', 'res.body'],
        }),
      }),
    );
  }

  app.use(cors({ origin: config.corsOrigins, credentials: true }));

  app.use(express.json({ limit: BODY_LIMIT }));

  // CSV arrives as a raw body rather than multipart — one less dependency in
  // the only endpoint that accepts a file.
  app.use(
    express.text({
      type: ['text/csv', 'application/csv', 'text/plain'],
      limit: BODY_LIMIT,
    }),
  );

  app.get('/health', async (_req, res) => {
    // Quarantine depth and publishing posture are here rather than buried in
    // an admin screen, so a monitor can see both without logging in. A
    // growing quarantine means events are being refused; a posture of NONE
    // means nothing about this chain is independently verifiable.
    let quarantined = null;
    try { quarantined = await unreviewedQuarantine(); } catch { /* health must not fail on the DB */ }

    res.json({
      ok: true,
      product: config.branding.productName,
      env: config.env,
      phase: 2,
      quarantine_unreviewed: quarantined,
      publishing: publishingPosture().level,
    });
  });

  authRoutes(app);
  employeeRoutes(app);
  eventRoutes(app);
  faceEnrolmentRoutes(app);

  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'No such endpoint.' });
  });

  // Four arguments: this is Express's error-handler signature and it is not
  // recognised as one without the trailing `next`, unused though it is.
  app.use((error, req, res, _next) => {
    req.log?.error({ err: error }, 'unhandled error');
    if (res.headersSent) return;

    // express.json() rejects a malformed body with a 400 before any route
    // sees it. Answer in our own shape rather than Express's HTML page.
    const status = error.status ?? error.statusCode ?? 500;
    res.status(status).json({
      error: status === 500 ? 'INTERNAL' : (error.code ?? 'ERROR'),
      // Never leak an internal message to a client — it may quote a value.
      message: status === 500 ? 'Something went wrong. Try again.' : error.message,
    });
  });

  return app;
}
