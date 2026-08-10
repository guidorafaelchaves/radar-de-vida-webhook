import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCanonicalMeasurements,
  buildDailySummary,
  buildRawRecordFingerprint,
  normalizeHealthSnapshot,
  stableStringify
} from './normalizers.js';

test('stableStringify is deterministic for object key order', () => {
  assert.equal(
    stableStringify({ b: 2, a: 1, nested: { z: true, c: false } }),
    stableStringify({ nested: { c: false, z: true }, a: 1, b: 2 })
  );
});

test('buildRawRecordFingerprint uses sourceRecordId when present', () => {
  const a = buildRawRecordFingerprint({
    source: 'health_connect',
    sourceRecordId: 'abc',
    recordType: 'steps',
    startTime: '2026-08-10T00:00:00-03:00'
  });
  const b = buildRawRecordFingerprint({
    source: 'health_connect',
    sourceRecordId: 'abc',
    recordType: 'steps',
    payload: { changed: true },
    startTime: '2026-08-10T00:00:00-03:00'
  });
  assert.equal(a, b);
});

test('normalizeHealthSnapshot accepts nested Zepp/Health Connect shape', () => {
  const snapshot = normalizeHealthSnapshot({
    source: 'health_connect',
    deviceId: 'amazfit-trex3-guido',
    deviceModel: 'Amazfit T-Rex 3',
    date: '2026-08-10',
    steps: 8042,
    activity: {
      activeMinutes: 67,
      totalCalories: 2650
    },
    sleep: {
      durationMinutes: 418,
      deepMinutes: 75
    },
    heartRate: {
      restingBpm: 58,
      averageBpm: 82,
      maxBpm: 149
    },
    body: {
      weightKg: 105.6,
      spo2: 97
    }
  });

  assert.equal(snapshot.source, 'health_connect');
  assert.equal(snapshot.device.id, 'amazfit-trex3-guido');
  assert.equal(snapshot.metrics.steps, 8042);
  assert.equal(snapshot.metrics.activeMinutes, 67);
  assert.equal(snapshot.metrics.sleepMinutes, 418);
  assert.equal(snapshot.metrics.restingHeartRate, 58);
  assert.equal(snapshot.metrics.weightKg, 105.6);
  assert.equal(snapshot.quality.status, 'valid');
});

test('quality marks implausible values as suspected without dropping payload', () => {
  const snapshot = normalizeHealthSnapshot({
    source: 'health_connect',
    date: '2026-08-10',
    steps: 150000,
    sleepMinutes: 1300,
    avgHeartRate: 250,
    weightKg: 500
  });

  assert.equal(snapshot.quality.status, 'suspected');
  assert.deepEqual(snapshot.quality.issues, [
    'steps_extreme',
    'sleep_minutes_implausible',
    'avg_heart_rate_implausible',
    'weight_kg_implausible'
  ]);
  assert.equal(snapshot.raw.steps, 150000);
});

test('buildCanonicalMeasurements emits only present non-zero metrics', () => {
  const snapshot = normalizeHealthSnapshot({
    source: 'health_connect',
    deviceId: 'amazfit-trex3-guido',
    date: '2026-08-10',
    steps: 8042,
    activeMinutes: 67,
    avgHeartRate: 82
  });
  const rows = buildCanonicalMeasurements(snapshot);

  assert.deepEqual(rows.map(row => row.metric), ['steps', 'activeMinutes', 'avgHeartRate']);
  assert.equal(rows[0].unit, 'count');
  assert.equal(rows[0].timezone, 'America/Recife');
});

test('buildDailySummary creates a daily aggregate draft', () => {
  const snapshot = normalizeHealthSnapshot({
    source: 'health_connect',
    deviceId: 'amazfit-trex3-guido',
    date: '2026-08-10',
    steps: 8042,
    distanceMeters: 6100,
    activeMinutes: 67,
    sleep: { durationMinutes: 418 },
    workout: { durationMinutes: 42 },
    heartRate: { averageBpm: 82, maxBpm: 149 }
  });
  const daily = buildDailySummary(snapshot);

  assert.equal(daily.date, '2026-08-10');
  assert.equal(daily.steps, 8042);
  assert.equal(daily.distanceM, 6100);
  assert.equal(daily.sleepMinutes, 418);
  assert.equal(daily.workoutsCount, 1);
  assert.equal(daily.avgHr, 82);
});

