import pino from 'pino';
import { buildApp } from './app.js';
import { config, assertProductionSafe } from './config.js';
import { closePool } from './db.js';

assertProductionSafe();

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const app = buildApp();

const server = app.listen(config.port, config.host, () => {
  log.info(
    `${config.branding.productName} API listening on ${config.host}:${config.port}`,
  );
});

server.on('error', (err) => {
  log.error({ err }, 'failed to start');
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  });
}
