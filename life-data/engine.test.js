import test from 'node:test';
import assert from 'node:assert/strict';
import {
  processLifeDataIngestion,
  readLifeDataEngineConfig
} from './engine.js';

test('readLifeDataEngineConfig keeps every flag disabled by default', () => {
  const config = readLifeDataEngineConfig({});

  assert.deepEqual(config, {
    engineEnabled: false,
    ingestionEnabled: false,
    storageEnabled: false,
    writeThroughEnabled: false,
    failOnStorageError: false,
    debugLogs: false
  });
});

test('processLifeDataIngestion refuses to plan when core flags are disabled', async () => {
  await assert.rejects(
    () => processLifeDataIngestion({ source: 'x', payload: {} }, { env: {} }),
    err => err.code === 'LIFE_DATA_INGESTION_DISABLED'
  );
});

test('processLifeDataIngestion creates a plan without touching storage by default', async () => {
  const result = await processLifeDataIngestion(
    {
      source: 'health_connect',
      device: { id: 'amazfit-trex3-guido' },
      payload: {
        recordType: 'health_daily_snapshot',
        date: '2026-08-10',
        steps: 8042
      }
    },
    {
      env: {
        LIFE_DATA_ENGINE_ENABLED: 'true',
        LIFE_DATA_INGESTION_ENABLED: 'true'
      },
      db: new ThrowingDb()
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'plan_only');
  assert.equal(result.persisted, false);
  assert.equal(result.plan.operations.rawRecords, 1);
  assert.equal(result.storage.attempted, false);
  assert.equal(result.storage.reason, 'storage_and_write_through_disabled');
});

test('processLifeDataIngestion persists when storage and write-through flags are enabled', async () => {
  const db = new FakeDbClient();

  const result = await processLifeDataIngestion(
    {
      source: 'health_connect',
      device: { id: 'amazfit-trex3-guido' },
      payload: {
        recordType: 'health_daily_snapshot',
        date: '2026-08-10',
        steps: 8042
      }
    },
    {
      env: {
        LIFE_DATA_ENGINE_ENABLED: 'true',
        LIFE_DATA_INGESTION_ENABLED: 'true',
        LIFE_DATA_STORAGE_ENABLED: 'true',
        LIFE_DATA_WRITE_THROUGH_ENABLED: 'true'
      },
      db
    }
  );

  assert.equal(result.mode, 'write_through');
  assert.equal(result.persisted, true);
  assert.equal(result.storage.attempted, true);
  assert.equal(result.storage.result.rawRecordId, 'raw-1');
  assert.ok(hasSql(db, 'insert into raw_records'));
  assert.equal(lastSql(db), 'commit');
});

test('processLifeDataIngestion returns a storage warning when persistence fails softly', async () => {
  const result = await processLifeDataIngestion(
    {
      source: 'health_connect',
      device: { id: 'amazfit-trex3-guido' },
      payload: {
        recordType: 'health_daily_snapshot',
        date: '2026-08-10',
        steps: 8042
      }
    },
    {
      env: {
        LIFE_DATA_ENGINE_ENABLED: 'true',
        LIFE_DATA_INGESTION_ENABLED: 'true',
        LIFE_DATA_STORAGE_ENABLED: 'true',
        LIFE_DATA_WRITE_THROUGH_ENABLED: 'true'
      },
      db: new ThrowingDb('storage unavailable')
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'plan_with_storage_warning');
  assert.equal(result.persisted, false);
  assert.equal(result.storage.attempted, true);
  assert.equal(result.storage.error.message, 'storage unavailable');
});

test('processLifeDataIngestion rethrows storage errors when fail flag is enabled', async () => {
  await assert.rejects(
    () => processLifeDataIngestion(
      {
        source: 'health_connect',
        device: { id: 'amazfit-trex3-guido' },
        payload: {
          recordType: 'health_daily_snapshot',
          date: '2026-08-10',
          steps: 8042
        }
      },
      {
        env: {
          LIFE_DATA_ENGINE_ENABLED: 'true',
          LIFE_DATA_INGESTION_ENABLED: 'true',
          LIFE_DATA_STORAGE_ENABLED: 'true',
          LIFE_DATA_WRITE_THROUGH_ENABLED: 'true',
          LIFE_DATA_FAIL_ON_STORAGE_ERROR: 'true'
        },
        db: new ThrowingDb('hard fail')
      }
    ),
    /hard fail/
  );
});

class ThrowingDb {
  constructor(message = 'storage should not be touched') {
    this.message = message;
  }

  async query() {
    throw new Error(this.message);
  }
}

class FakeDbClient {
  constructor() {
    this.calls = [];
    this.counters = new Map();
  }

  async query(sql, params = []) {
    const normalized = normalizeSql(sql);
    this.calls.push({ normalized, params });

    if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
      return { rows: [] };
    }

    const table = tableNameFor(normalized);
    const id = table ? `${table}-${this.next(table)}` : `row-${this.calls.length}`;
    return { rows: [{ id }] };
  }

  next(table) {
    const current = this.counters.get(table) || 0;
    const next = current + 1;
    this.counters.set(table, next);
    return next;
  }
}

function tableNameFor(sql) {
  const tables = [
    ['insert into data_sources', 'source'],
    ['insert into devices', 'device'],
    ['insert into raw_records', 'raw'],
    ['insert into health_measurements', 'measurement'],
    ['insert into health_daily', 'daily']
  ];
  return tables.find(([needle]) => sql.includes(needle))?.[1] || null;
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
