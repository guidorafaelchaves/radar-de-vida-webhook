import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = join(here, 'migrations');
export const MIGRATIONS_TABLE = 'life_data_schema_migrations';

export async function loadMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const files = (await readdir(migrationsDir))
    .filter(file => /^\d+_.+\.sql$/i.test(file))
    .sort((a, b) => a.localeCompare(b));

  const migrations = [];
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    migrations.push(buildMigration(file, sql));
  }
  return migrations;
}

export function buildMigration(name, sql) {
  if (!name || typeof name !== 'string') {
    throw new Error('Invalid Life Data migration: name_required');
  }
  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    throw new Error(`Invalid Life Data migration ${name}: sql_required`);
  }
  return {
    name,
    sql,
    checksum: sha256(sql)
  };
}

export async function planMigrations(db, options = {}) {
  const client = await acquireClient(db);
  const release = releaser(client, db);

  try {
    const migrations = options.migrations || await loadMigrations(options.migrationsDir);
    await ensureMigrationsTable(client);
    const applied = await readAppliedMigrations(client);
    return buildMigrationPlan(migrations, applied);
  } finally {
    release();
  }
}

export async function runMigrations(db, options = {}) {
  const client = await acquireClient(db);
  const release = releaser(client, db);

  try {
    const migrations = options.migrations || await loadMigrations(options.migrationsDir);
    await ensureMigrationsTable(client);
    const applied = await readAppliedMigrations(client);
    const plan = buildMigrationPlan(migrations, applied);

    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        applied: [],
        pending: plan.pending,
        skipped: plan.skipped
      };
    }

    const appliedNow = [];
    for (const migration of plan.pending) {
      await client.query('begin');
      try {
        await client.query(migration.sql);
        await recordMigration(client, migration);
        await client.query('commit');
        appliedNow.push({
          name: migration.name,
          checksum: migration.checksum
        });
      } catch (error) {
        try {
          await client.query('rollback');
        } catch {
          // Preserve the original migration failure.
        }
        error.migrationName = migration.name;
        throw error;
      }
    }

    return {
      ok: true,
      dryRun: false,
      applied: appliedNow,
      pending: [],
      skipped: plan.skipped
    };
  } finally {
    release();
  }
}

export function buildMigrationPlan(migrations, appliedRows = []) {
  const appliedByName = new Map(
    appliedRows.map(row => [row.name || row.migration_name, row.checksum])
  );
  const pending = [];
  const skipped = [];

  for (const migration of migrations.map(item => buildMigration(item.name, item.sql))) {
    const appliedChecksum = appliedByName.get(migration.name);
    if (!appliedChecksum) {
      pending.push(migration);
      continue;
    }
    if (appliedChecksum !== migration.checksum) {
      const error = new Error(`Life Data migration checksum changed: ${migration.name}`);
      error.code = 'LIFE_DATA_MIGRATION_CHECKSUM_CHANGED';
      error.migrationName = migration.name;
      throw error;
    }
    skipped.push({
      name: migration.name,
      checksum: migration.checksum
    });
  }

  return { pending, skipped };
}

async function acquireClient(db) {
  if (!db) {
    throw new Error('Life Data migrations require a db client or pool.');
  }
  if (typeof db.connect === 'function') return db.connect();
  if (typeof db.query === 'function') return db;
  throw new Error('Life Data migrations db must expose query(sql, params) or connect().');
}

function releaser(client, db) {
  return typeof client.release === 'function' && client !== db
    ? () => client.release()
    : () => {};
}

async function ensureMigrationsTable(client) {
  await client.query(
    `create table if not exists ${MIGRATIONS_TABLE} (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`
  );
}

async function readAppliedMigrations(client) {
  const result = await client.query(
    `select name, checksum
     from ${MIGRATIONS_TABLE}
     order by name asc`
  );
  return result?.rows || [];
}

async function recordMigration(client, migration) {
  await client.query(
    `insert into ${MIGRATIONS_TABLE} (name, checksum)
     values ($1, $2)
     on conflict (name) do update set
      checksum = excluded.checksum,
      applied_at = now()`,
    [migration.name, migration.checksum]
  );
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
