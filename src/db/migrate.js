/**
 * Apply the schema. Idempotent — every statement is CREATE TABLE IF NOT EXISTS.
 *
 * Run:  npm run db:migrate
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');

  // Connect without a database first so we can create it if it is missing.
  const bootstrap = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  });

  await bootstrap.query(
    `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await bootstrap.end();

  const conn = await mysql.createConnection({
    ...config.db,
    multipleStatements: true,
  });

  await conn.query(sql);
  await upgradeExistingTables(conn);
  await conn.end();

  console.log(`✓ schema applied to "${config.db.database}"`);
}

/**
 * schema.sql only ever CREATEs. A database that already exists keeps its old
 * column and index list, so anything added after the first deployment has to
 * be applied here as well.
 *
 * MySQL has no ADD COLUMN IF NOT EXISTS, so each change is guarded by a look
 * in information_schema. Every one of these is safe to run repeatedly.
 */
async function upgradeExistingTables(conn) {
  const db = config.db.database;

  const hasColumn = async (table, column) => {
    const [rows] = await conn.query(
      `SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [db, table, column],
    );
    return rows.length > 0;
  };

  const hasIndex = async (table, index) => {
    const [rows] = await conn.query(
      `SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [db, table, index],
    );
    return rows.length > 0;
  };

  if (!(await hasColumn('employees', 'email'))) {
    await conn.query('ALTER TABLE employees ADD COLUMN email VARCHAR(255) NULL AFTER phone');
    console.log('  + employees.email');
  }
  if (!(await hasIndex('employees', 'uq_employees_email'))) {
    await conn.query('ALTER TABLE employees ADD UNIQUE KEY uq_employees_email (email)');
    console.log('  + employees.uq_employees_email');
  }

  if (!(await hasIndex('employees', 'uq_employees_phone'))) {
    // One number is one person. Say which numbers break that rule rather
    // than letting MySQL fail with a duplicate-key error naming only one.
    const [dups] = await conn.query(
      `SELECT phone, COUNT(*) AS n, GROUP_CONCAT(employee_id ORDER BY employee_id) AS ids
         FROM employees GROUP BY phone HAVING n > 1 ORDER BY n DESC LIMIT 20`,
    );
    if (dups.length > 0) {
      console.error('\n✗ cannot make phone unique — these numbers are shared:\n');
      for (const d of dups) console.error(`    ${d.phone}  ->  ${d.ids}`);
      console.error('\n  Fix these in the employee master, then run the migration again.');
      throw new Error(`${dups.length} duplicate phone number(s)`);
    }
    if (await hasIndex('employees', 'idx_employees_phone')) {
      await conn.query('ALTER TABLE employees DROP INDEX idx_employees_phone');
    }
    await conn.query('ALTER TABLE employees ADD UNIQUE KEY uq_employees_phone (phone)');
    console.log('  + employees.uq_employees_phone');
  }

  if (!(await hasColumn('otp_codes', 'channel'))) {
    await conn.query(
      `ALTER TABLE otp_codes
         ADD COLUMN channel ENUM('SMS','EMAIL') NOT NULL DEFAULT 'SMS' AFTER code_hash`,
    );
    console.log('  + otp_codes.channel');
  }
}

main().catch((err) => {
  console.error('✗ migration failed:', err.message);
  process.exit(1);
});
