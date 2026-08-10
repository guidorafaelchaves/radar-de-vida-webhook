import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMigration,
  buildMigrationPlan,
  planMigrations,
  runMigrations
} from './migrations.js';

test('buildMigrationPlan separates pending and already applied migrations', () => {
  const first = buildMigration('001_initial_schema.sql', 'create table example(id text);');
  const second = buildMigration('002_next.sql', 'alter table example add column name text;');

  const plan = buildMigrationPlan([first, second], [
    { name: first.name, checksum: first.checksum }
  ]);

  assert.deepEqual(plan.skipped, [{ name: first.name, checksum: first.checksum }]);
  assert.deepEqual(plan.pending.map(item => item.name), ['002_next.sql']);
});

test('buildMigrationPlan rejects changed SQL for an applied migration', () => {
  const original = buildMigration('001_initial_schema.sql', 'create table original(id text);');
  const changed = buildMigration('001_initial_schema.sql', 'create table changed(id text);');

  assert.throws(
    () => buildMigrationPlan([changed], [{ name: original.name, checksum: original.checksum }]),
    err => err.code === 'LIFE_DATA_MIGRATION_CHECKSUM_CHANGED' &&
      err.migrationName === '001_initial_schema.sql'
  );
});

test('planMigrations builds a dry plan without running migration SQL', async () => {
  const client = new FakeMigrationClient();
  const migration = buildMigration('001_initial_schema.sql', 'create table life_data_test(id text);');

  const plan = await planMigrations(client, { migrations: [migration] });

  assert.equal(plan.pending.length, 1);
  assert.equal(plan.skipped.length, 0);
  assert.ok(hasSql(client, 'create table if not exists life_data_schema_migrations'));
  assert.ok(hasSql(client, 'select name, checksum'));
  assert.equal(hasSql(client, 'create table life_data_test'), false);
});

test('runMigrations applies pending migrations transactionally', async () => {
  const client = new FakeMigrationClient();
  const migration = buildMigration('001_initial_schema.sql', 'create table life_data_test(id text);');

  const result = await runMigrations(client, { migrations: [migration] });

  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].name, '001_initial_schema.sql');
  assert.ok(hasSql(client, 'begin'));
  assert.ok(hasSql(client, 'create table life_data_test'));
  assert.ok(hasSql(client, 'insert into life_data_schema_migrations'));
  assert.equal(lastSql(client), 'commit');
});

test('runMigrations dryRun returns pending migrations without executing them', async () => {
  const client = new FakeMigrationClient();
  const migration = buildMigration('001_initial_schema.sql', 'create table dry_run_only(id text);');

  const result = await runMigrations(client, { migrations: [migration], dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.pending.length, 1);
  assert.equal(hasSql(client, 'begin'), false);
  assert.equal(hasSql(client, 'create table dry_run_only'), false);
});

test('runMigrations rolls back and reports the migration name on failure', async () => {
  const client = new FakeMigrationClient({ failOn: 'create table broken' });
  const migration = buildMigration('002_broken.sql', 'create table broken(id text);');

  await assert.rejects(
    () => runMigrations(client, { migrations: [migration] }),
    err => /forced migration failure/.test(err.message) &&
      err.migrationName === '002_broken.sql'
  );

  assert.ok(hasSql(client, 'begin'));
  assert.equal(lastSql(client), 'rollback');
});

class FakeMigrationClient {
  constructor(options = {}) {
    this.options = options;
    this.calls = [];
    this.applied = options.applied || [];
  }

  async query(sql, params = []) {
    const normalized = normalizeSql(sql);
    this.calls.push({ sql, normalized, params });

    if (this.options.failOn && normalized.includes(this.options.failOn)) {
      throw new Error(`forced migration failure on ${this.options.failOn}`);
    }

    if (normalized.startsWith('select name, checksum')) {
      return { rows: this.applied };
    }

    if (normalized.startsWith('insert into life_data_schema_migrations')) {
      this.applied.push({ name: params[0], checksum: params[1] });
    }

    return { rows: [] };
  }
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
}

function hasSql(client, needle) {
  return client.calls.some(call => call.normalized.includes(needle));
}

function lastSql(client) {
  return client.calls.at(-1)?.normalized;
}
