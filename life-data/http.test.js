import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLifeDataErrorResponse,
  buildLifeDataPlanHttpResponse,
  buildLifeDataStatusHttpResponse
} from './http.js';

test('buildLifeDataStatusHttpResponse reports disabled mode without leaking database URL', () => {
  const response = buildLifeDataStatusHttpResponse({
    now: '2026-08-10T10:00:00.000Z',
    siteUrl: 'https://radar-de-vida-webhook.onrender.com',
    lifeDataFlags: { engine: false, ingestion: false },
    env: {
      LIFE_DATA_DATABASE_URL: 'postgres://secret-user:secret-pass@example.test/radar'
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.mode, 'disabled');
  assert.equal(response.body.siteUrl, 'https://radar-de-vida-webhook.onrender.com');
  assert.equal(response.body.storage.configured, true);
  assert.equal(JSON.stringify(response.body).includes('secret-pass'), false);
});

test('buildLifeDataStatusHttpResponse reports plan-only mode', () => {
  const response = buildLifeDataStatusHttpResponse({
    lifeDataFlags: {
      engine: true,
      ingestion: true,
      storage: false,
      writeThrough: false
    },
    env: {}
  });

  assert.equal(response.body.mode, 'plan_only');
  assert.equal(response.body.storage.configured, false);
  assert.equal(response.body.safety.currentWritePath, 'plan_only_or_disabled');
});

test('buildLifeDataStatusHttpResponse reports armed write-through mode', () => {
  const response = buildLifeDataStatusHttpResponse({
    lifeDataFlags: {
      engine: true,
      ingestion: true,
      storage: true,
      writeThrough: true
    },
    env: {
      LIFE_DATA_DATABASE_URL: 'postgres://example'
    }
  });

  assert.equal(response.body.mode, 'write_through_armed');
  assert.equal(response.body.storage.writeThroughEnabled, true);
  assert.equal(response.body.safety.currentWritePath, 'write_through_possible');
});

test('buildLifeDataPlanHttpResponse returns the public endpoint contract', async () => {
  const response = await buildLifeDataPlanHttpResponse(
    { payload: { recordType: 'health_daily_snapshot' } },
    {
      lifeDataFlags: { engine: true, ingestion: true },
      processLifeDataIngestion: async () => ({
        mode: 'plan_only',
        persisted: false,
        storage: { attempted: false, reason: 'write_through_disabled' },
        plan: {
          ok: true,
          operations: { rawRecords: 1 }
        }
      })
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true,
    mode: 'plan_only',
    persisted: false,
    lifeDataFlags: { engine: true, ingestion: true },
    storage: { attempted: false, reason: 'write_through_disabled' },
    plan: {
      ok: true,
      operations: { rawRecords: 1 }
    }
  });
});

test('buildLifeDataPlanHttpResponse maps disabled ingestion to 404', async () => {
  const response = await buildLifeDataPlanHttpResponse(
    {},
    {
      processLifeDataIngestion: async () => {
        const error = new Error('disabled');
        error.code = 'LIFE_DATA_INGESTION_DISABLED';
        error.requiredFlags = {
          LIFE_DATA_ENGINE_ENABLED: true,
          LIFE_DATA_INGESTION_ENABLED: true
        };
        throw error;
      }
    }
  );

  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, 'LIFE_DATA_INGESTION_DISABLED');
  assert.deepEqual(response.body.requiredFlags, {
    LIFE_DATA_ENGINE_ENABLED: true,
    LIFE_DATA_INGESTION_ENABLED: true
  });
});

test('buildLifeDataPlanHttpResponse maps validation errors to 400 with details', async () => {
  const response = await buildLifeDataPlanHttpResponse(
    {},
    {
      processLifeDataIngestion: async () => {
        const error = new Error('Invalid ingestion envelope');
        error.code = 'INVALID_LIFE_DATA_INGESTION_ENVELOPE';
        error.errors = ['source_required'];
        throw error;
      }
    }
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, 'INVALID_LIFE_DATA_INGESTION_ENVELOPE');
  assert.deepEqual(response.body.errors, ['source_required']);
});

test('buildLifeDataErrorResponse uses a generic code for unknown errors', () => {
  const response = buildLifeDataErrorResponse(new Error('boom'));

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    ok: false,
    error: 'boom',
    code: 'LIFE_DATA_PLAN_ERROR',
    errors: []
  });
});
