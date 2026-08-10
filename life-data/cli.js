#!/usr/bin/env node
import { createLifeDataPool } from './database.js';
import {
  loadMigrations,
  planMigrations,
  runMigrations
} from './migrations.js';

const command = process.argv[2] || 'help';

try {
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  if (!['migrations:plan', 'migrations:dry-run', 'migrations:run'].includes(command)) {
    throw new Error(`Unknown Life Data command: ${command}`);
  }

  const pool = await createLifeDataPool();
  try {
    if (command === 'migrations:plan') {
      const plan = await planMigrations(pool);
      printMigrationPlan(plan);
    }

    if (command === 'migrations:dry-run') {
      const result = await runMigrations(pool, { dryRun: true });
      printMigrationResult(result);
    }

    if (command === 'migrations:run') {
      requireRunConfirmation();
      const result = await runMigrations(pool);
      printMigrationResult(result);
    }
  } finally {
    await pool.end();
  }
} catch (error) {
  console.error(`Life Data command failed: ${error.message}`);
  if (error.code) console.error(`Code: ${error.code}`);
  if (error.migrationName) console.error(`Migration: ${error.migrationName}`);
  process.exit(1);
}

function printHelp() {
  console.log(`
Radar Life Data CLI

Commands:
  migrations:plan      Show pending/applied migrations using LIFE_DATA_DATABASE_URL.
  migrations:dry-run   Validate migration state without executing pending SQL.
  migrations:run       Execute pending migrations. Requires LIFE_DATA_CONFIRM_RUN=yes.

Environment:
  LIFE_DATA_DATABASE_URL              Required Postgres connection string.
  LIFE_DATA_DATABASE_SSL              Optional. true/false/no-verify. Defaults false.
  LIFE_DATA_DATABASE_POOL_MAX         Optional. Defaults 3.
  LIFE_DATA_CONFIRM_RUN=yes           Required only for migrations:run.

Examples:
  npm run life-data:migrations:plan
  npm run life-data:migrations:dry-run
  $env:LIFE_DATA_CONFIRM_RUN="yes"; npm run life-data:migrations:run
`.trim());
}

async function printMigrationPlan(plan) {
  const migrations = await loadMigrations();
  const byName = new Map(migrations.map(item => [item.name, item]));
  console.log(JSON.stringify({
    pending: plan.pending.map(item => summarizeMigration(item)),
    skipped: plan.skipped.map(item => ({
      ...item,
      known: byName.has(item.name)
    }))
  }, null, 2));
}

function printMigrationResult(result) {
  console.log(JSON.stringify({
    ok: result.ok,
    dryRun: result.dryRun,
    applied: result.applied,
    pending: result.pending?.map(item => summarizeMigration(item)) || [],
    skipped: result.skipped
  }, null, 2));
}

function summarizeMigration(migration) {
  return {
    name: migration.name,
    checksum: migration.checksum,
    bytes: Buffer.byteLength(migration.sql || '', 'utf8')
  };
}

function requireRunConfirmation() {
  if (process.env.LIFE_DATA_CONFIRM_RUN === 'yes') return;
  throw new Error('Refusing to run migrations without LIFE_DATA_CONFIRM_RUN=yes.');
}
