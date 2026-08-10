import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIngestionPlan } from './ingestion.js';
import {
  createLifeDataRepository,
  persistIngestionPlan
} from './repository.js';

test('persistIngestionPlan writes a health plan inside a transaction', async () => {
  const client = new FakeDbClient();
  const plan = buildIngestionPlan({
    source: 'health_connect',
    sourceRecordId: 'hc-2026-08-10',
    device: {
      id: 'amazfit-trex3-guido',
      model: 'Amazfit T-Rex 3',
      manufacturer: 'Zepp'
    },
    payload: {
      recordType: 'health_daily_snapshot',
      date: '2026-08-10',
      steps: 8042,
      activeMinutes: 67,
      heartRate: { averageBpm: 82 }
    }
  });

  const result = await persistIngestionPlan(client, plan);

  assert.equal(result.ok, true);
  assert.equal(result.rawRecordId, 'raw-1');
  assert.equal(firstSql(client), 'begin');
  assert.equal(lastSql(client), 'commit');
  assert.equal(countSql(client, 'rollback'), 0);
  assert.ok(hasSql(client, 'insert into data_sources'));
  assert.ok(hasSql(client, 'insert into devices'));
  assert.ok(hasSql(client, 'insert into raw_records'));
  assert.equal(countSql(client, 'insert into health_measurements'), 3);
  assert.ok(hasSql(client, 'insert into health_daily'));
});

test('createLifeDataRepository exposes the same persistence contract', async () => {
  const client = new FakeDbClient();
  const repo = createLifeDataRepository(client);
  const plan = buildIngestionPlan({
    source: 'radar_semantic',
    recordType: 'semantic_event',
    payload: { originalText: 'gastei R$ 12 no cafe', legacyFields: { dinheiro_gasto: 12 } }
  });

  const result = await repo.persistIngestionPlan(plan);

  assert.equal(result.ok, true);
  assert.ok(hasSql(client, 'insert into financial_events'));
});

test('persistIngestionPlan rolls back when a canonical write fails', async () => {
  const client = new FakeDbClient({ failOn: 'insert into health_daily' });
  const plan = buildIngestionPlan({
    source: 'health_connect',
    sourceRecordId: 'hc-2026-08-11',
    device: { id: 'amazfit-trex3-guido' },
    payload: {
      recordType: 'health_daily_snapshot',
      date: '2026-08-11',
      steps: 1000
    }
  });

  await assert.rejects(
    () => persistIngestionPlan(client, plan),
    /forced failure/
  );

  assert.equal(firstSql(client), 'begin');
  assert.equal(lastSql(client), 'rollback');
  assert.equal(countSql(client, 'commit'), 0);
});

test('persistIngestionPlan writes semantic, financial, nutrition and mission events', async () => {
  const client = new FakeDbClient();
  const plan = buildIngestionPlan({
    source: 'radar_semantic',
    recordType: 'semantic_event',
    sourceRecordId: 'entry-42',
    occurredAt: '2026-08-10T11:30:00-03:00',
    payload: {
      originalText: 'Nova missao: pagar guia. Comi arroz e frango. Gastei R$ 30.',
      legacyFields: {
        dinheiro_gasto: 30,
        calorias_ingeridas: 650,
        proteina_g: 45,
        categorias: ['missao', 'comida', 'gasto']
      },
      radarIntelligence: {
        missionParser: {
          intencao: 'criar',
          missao_alvo_aproximada: 'pagar guia',
          prioridade: 'media'
        }
      }
    }
  });

  const result = await persistIngestionPlan(client, plan);

  assert.equal(result.canonical.semanticEvents.length, 1);
  assert.equal(result.canonical.financialEvents.length, 1);
  assert.equal(result.canonical.nutritionEvents.length, 1);
  assert.equal(result.canonical.missionEvents.length, 1);
  assert.ok(hasSql(client, 'insert into semantic_events'));
  assert.ok(hasSql(client, 'insert into financial_events'));
  assert.ok(hasSql(client, 'insert into nutrition_events'));
  assert.ok(hasSql(client, 'insert into mission_events'));
});

test('persistIngestionPlan rejects invalid plans before opening a transaction', async () => {
  const client = new FakeDbClient();

  await assert.rejects(
    () => persistIngestionPlan(client, { ok: true }),
    /raw_record_required/
  );

  assert.equal(client.calls.length, 0);
});

class FakeDbClient {
  constructor(options = {}) {
    this.options = options;
    this.calls = [];
    this.counters = new Map();
  }

  async query(sql, params = []) {
    const normalized = normalizeSql(sql);
    this.calls.push({ sql, normalized, params });

    if (this.options.failOn && normalized.includes(this.options.failOn)) {
      throw new Error(`forced failure on ${this.options.failOn}`);
    }

    if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
      return { rows: [] };
    }

    const table = tableNameFor(normalized);
    const id = table ? `${table}-${this.next(table)}` : `row-${this.calls.length}`;
    return { rows: [{ id, metric: params[3], title: params[9], event_type: params[2], mission_key: params[1] }] };
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
    ['insert into health_daily', 'daily'],
    ['insert into semantic_events', 'semantic'],
    ['insert into financial_events', 'financial'],
    ['insert into nutrition_events', 'nutrition'],
    ['insert into mission_events', 'mission']
  ];
  return tables.find(([needle]) => sql.includes(needle))?.[1] || null;
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
}

function firstSql(client) {
  return client.calls[0]?.normalized;
}

function lastSql(client) {
  return client.calls.at(-1)?.normalized;
}

function hasSql(client, needle) {
  return client.calls.some(call => call.normalized.includes(needle));
}

function countSql(client, needle) {
  return client.calls.filter(call => call.normalized.includes(needle)).length;
}
