import pino from 'pino';
import { buildApp } from './app.js';
import { config, assertProductionSafe } from './config.js';
import { connect, closeClient, assertDeploymentSupportsChain } from './db/mongo.js';

assertProductionSafe();

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// Connect BEFORE listening, and refuse to serve a deployment that cannot keep
// the chain gapless. A standalone mongod accepts every write in this codebase
// and only loses the transaction guarantee, so the failure would appear much
// later as a forked or gapped chain rather than as a connection error. That is
// not a thing to discover in production.
await connect();
const deployment = await assertDeploymentSupportsChain();
log.info({ replicaSet: deployment.replicaSet }, 'mongodb connected');

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
      await closeClient();
      process.exit(0);
    });
  });
}
