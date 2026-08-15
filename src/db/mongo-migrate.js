/**
 * Apply the MongoDB schema. Idempotent. Replaces db/migrate.js.
 *
 *   npm run db:migrate:mongo
 *
 * Unlike the MySQL version there is no CREATE DATABASE step: MongoDB creates a
 * database when something is first written to it. What this does instead is
 * create the collections with their validators, build every index, seed the
 * single chain-head document, and then REFUSE to finish if the deployment
 * cannot keep the chain correct.
 */

import { connect, closeClient, assertDeploymentSupportsChain } from './mongo.js';
import { applySchema, assertEventsCollectionSafe, assertReferentialIntegrity } from './mongo-schema.js';
import { config } from '../config.js';

async function main() {
  await connect();

  const deployment = await assertDeploymentSupportsChain();
  console.log(`→ replica set "${deployment.replicaSet}", primary: ${deployment.primary}`);

  await applySchema();

  const events = await assertEventsCollectionSafe();
  console.log(`✓ events collection is append-only safe — not capped, no TTL, ${events.indexes} indexes`);

  const refs = await assertReferentialIntegrity();
  if (refs.ok) {
    console.log('✓ referential integrity holds (what the foreign keys used to guarantee)');
  } else {
    console.log('⚠ referential integrity problems:');
    for (const p of refs.problems) console.log(`    ${p.constraint}: ${p.detail}`);
  }

  console.log(`\n  database: ${config.mongo.database}`);
  await closeClient();
}

main().catch(async (err) => {
  console.error('✗ migration failed:', err.message);
  await closeClient().catch(() => {});
  process.exit(1);
});
