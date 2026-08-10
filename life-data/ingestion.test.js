import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIngestionPlan,
  normalizeIngestionEnvelope,
  serializeIngestionPlan
} from './ingestion.js';

test('normalizeIngestionEnvelope infers health snapshot type', () => {
  const envelope = normalizeIngestionEnvelope({
    source: 'health_connect',
    deviceId: 'amazfit-trex3-guido',
    date: '2026-08-10',
    steps: 8042
  });

  assert.equal(envelope.recordType, 'health_daily_snapshot');
  assert.equal(envelope.source, 'health_connect');
  assert.equal(envelope.device.id, 'amazfit-trex3-guido');
  assert.equal(envelope.timezone, 'America/Recife');
});

test('buildIngestionPlan creates raw and canonical health operations', () => {
  const plan = buildIngestionPlan({
    source: 'health_connect',
    sourceRecordId: 'hc-2026-08-10',
    device: {
      id: 'amazfit-trex3-guido',
      model: 'Amazfit T-Rex 3'
    },
    payload: {
      recordType: 'health_daily_snapshot',
      date: '2026-08-10',
      steps: 8042,
      activeMinutes: 67,
      heartRate: { averageBpm: 82 }
    }
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.rawRecord.sourceKey, 'health_connect');
  assert.equal(plan.rawRecord.sourceRecordId, 'hc-2026-08-10');
  assert.equal(plan.operations.rawRecords, 1);
  assert.equal(plan.operations.healthMeasurements, 3);
  assert.equal(plan.operations.healthDaily, 1);
  assert.equal(plan.canonical.healthDaily.steps, 8042);
});

test('buildIngestionPlan creates semantic, financial and mission drafts', () => {
  const plan = buildIngestionPlan({
    source: 'radar_semantic',
    recordType: 'semantic_event',
    sourceRecordId: 'entry-1',
    occurredAt: '2026-08-10T10:20:00-03:00',
    payload: {
      originalText: 'Nova missao: pagar guia do cartorio. Recebi R$ 42 de MXRF11.',
      legacyFields: {
        dinheiro_ganho: 42,
        categorias: ['missao', 'rendimentos']
      },
      radarIntelligence: {
        missionParser: {
          intencao: 'CRIAR',
          missao_alvo_aproximada: 'pagar guia do cartorio',
          prioridade: 'alta'
        }
      }
    }
  });

  assert.equal(plan.operations.semanticEvents, 1);
  assert.equal(plan.operations.financialEvents, 1);
  assert.equal(plan.operations.missionEvents, 1);
  assert.equal(plan.canonical.semanticEvents[0].domain, 'mission');
  assert.equal(plan.canonical.financialEvents[0].amount, 42);
  assert.equal(plan.canonical.missionEvents[0].missionKey, 'pagar-guia-do-cartorio');
});

test('buildIngestionPlan rejects unsupported record type', () => {
  assert.throws(
    () => buildIngestionPlan({ source: 'x', recordType: 'unknown_type', payload: {} }),
    err => err.code === 'INVALID_LIFE_DATA_INGESTION_ENVELOPE' &&
      err.errors.includes('unsupported_record_type:unknown_type')
  );
});

test('serializeIngestionPlan is deterministic for the same plan', () => {
  const plan = buildIngestionPlan({
    source: 'radar_semantic',
    recordType: 'semantic_event',
    payload: { originalText: 'gastei R$ 10 no cafe', legacyFields: { dinheiro_gasto: 10 } }
  });

  assert.equal(serializeIngestionPlan(plan), serializeIngestionPlan(plan));
});

