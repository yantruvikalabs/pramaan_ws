/**
 * ⚠ LEGACY — MySQL. Not used by the running application.
 *
 * Every live path moved to MongoDB in D3 (docs/mongodb-migration-plan.md §P).
 * This file survives for exactly one reason: `tools/migrate-to-mongo.mjs` reads
 * the old database through it, and that tool is the only way to move a MySQL
 * chain across.
 *
 * Do not import this from `src/`. When the MySQL data is confirmed no longer
 * needed, delete this file, `src/db/migrate.js`, `src/db/schema.sql`,
 * `tools/migrate-to-mongo.mjs` and the `mysql2` dependency together.
 */

import mysql from 'mysql2/promise';
import { config } from './config.js';

let pool = null;

export function getPool() {
  if (pool === null) {
    pool = mysql.createPool({
      ...config.db,
      waitForConnections: true,
      queueLimit: 0,
      // Dates come back as strings so nothing silently reinterprets them in
      // the server's local timezone. FRD BR-SHF-3 — time handling is exact
      // and explicit everywhere in this product, never implicit.
      dateStrings: true,
      timezone: 'Z',
      charset: 'utf8mb4_unicode_ci',
      // Import inserts several thousand rows in one statement.
      multipleStatements: false,
      namedPlaceholders: false,
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 * The import uses this so a batch is all-or-nothing at the database level,
 * even though its VALIDATION is row-level. FRD BR-MST-1.
 */
export async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function closePool() {
  if (pool !== null) {
    await pool.end();
    pool = null;
  }
}
