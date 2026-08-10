import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLifeDataPool,
  readLifeDataDatabaseConfig,
  withLifeDataPool
} from './database.js';

test('readLifeDataDatabaseConfig reads a minimal Postgres URL', () => {
  const config = readLifeDataDatabaseConfig({
    LIFE_DATA_DATABASE_URL: 'postgres://user:pass@example.test:5432/radar'
  });

  assert.equal(config.connectionString, 'postgres://user:pass@example.test:5432/radar');
  assert.equal(config.ssl, false);
  assert.equal(config.max, 3);
});

test('readLifeDataDatabaseConfig accepts SSL and pool tuning', () => {
  const config = readLifeDataDatabaseConfig({
    LIFE_DATA_DATABASE_URL: 'postgres://example',
    LIFE_DATA_DATABASE_SSL: 'true',
    LIFE_DATA_DATABASE_POOL_MAX: '7',
    LIFE_DATA_DATABASE_IDLE_TIMEOUT_MS: '12000',
    LIFE_DATA_DATABASE_CONNECTION_TIMEOUT_MS: '8000'
  });

  assert.deepEqual(config.ssl, { rejectUnauthorized: false });
  assert.equal(config.max, 7);
  assert.equal(config.idleTimeoutMillis, 12000);
  assert.equal(config.connectionTimeoutMillis, 8000);
});

test('createLifeDataPool refuses to connect without database URL', async () => {
  await assert.rejects(
    () => createLifeDataPool({ env: {} }),
    /LIFE_DATA_DATABASE_URL is required/
  );
});

test('createLifeDataPool wraps missing pg package with an operational error', async () => {
  await assert.rejects(
    () => createLifeDataPool({
      config: { connectionString: 'postgres://example' },
      pgLoader: async () => {
        throw new Error('missing module');
      }
    }),
    err => err.code === 'LIFE_DATA_PG_PACKAGE_MISSING'
  );
});

test('withLifeDataPool closes the pool after callback', async () => {
  const calls = [];
  const result = await withLifeDataPool(
    async pool => {
      calls.push(pool.options.connectionString);
      return 'done';
    },
    {
      config: { connectionString: 'postgres://example' },
      pgLoader: async () => ({
        Pool: class FakePool {
          constructor(options) {
            this.options = options;
          }

          async end() {
            calls.push('end');
          }
        }
      })
    }
  );

  assert.equal(result, 'done');
  assert.deepEqual(calls, ['postgres://example', 'end']);
});
