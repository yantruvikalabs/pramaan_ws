import serverless from 'serverless-http';
import pino from 'pino';
import { buildApp } from '../../src/app.js';
import { assertProductionSafe } from '../../src/config.js';
import { connect, assertDeploymentSupportsChain } from '../../src/db/mongo.js';

assertProductionSafe();

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const app = buildApp({ healthDatabase: false });
const expressHandler = serverless(app);

let ready = null;

function stripDeployPrefix(path) {
  for (const prefix of ['/.netlify/functions/api', '/api']) {
    if (path === prefix) return '/';
    if (path?.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  }
  return path;
}

function normalizeEvent(event) {
  const normalized = { ...event };
  for (const key of ['path', 'rawPath', 'requestPath']) {
    if (typeof normalized[key] === 'string') {
      normalized[key] = stripDeployPrefix(normalized[key]);
    }
  }
  return normalized;
}

async function ensureReady() {
  if (!ready) {
    ready = (async () => {
      await connect();
      const deployment = await assertDeploymentSupportsChain();
      log.info({ replicaSet: deployment.replicaSet }, 'mongodb connected');
    })();
  }
  return ready;
}

export async function handler(event, context) {
  const normalized = normalizeEvent(event);
  if (normalized.path !== '/health' && normalized.rawPath !== '/health') {
    await ensureReady();
  }
  return expressHandler(normalized, context);
}
