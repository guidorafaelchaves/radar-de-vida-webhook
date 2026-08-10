import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLifeDataErrorResponse,
  buildLifeDataPlanHttpResponse
} from './http.js';

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
