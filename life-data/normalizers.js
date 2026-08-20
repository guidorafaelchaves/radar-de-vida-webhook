import { createHash } from 'node:crypto';

export const LIFE_DATA_SCHEMA_VERSION = 'life_data_v1';
export const DEFAULT_TIMEZONE = 'America/Recife';

export function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function buildRawRecordFingerprint(input = {}) {
  const source = cleanText(input.source) || 'unknown';
  const sourceRecordId = cleanText(input.sourceRecordId || input.source_record_id);
  const recordType = cleanText(input.recordType || input.record_type) || 'unknown';
  const startTime = cleanText(input.startTime || input.start_time);
  const endTime = cleanText(input.endTime || input.end_time);

  if (sourceRecordId) {
    return sha256([source, sourceRecordId, recordType, startTime, endTime].join('|'));
  }

  return sha256(stableStringify({
    source,
    recordType,
    deviceId: cleanText(input.deviceId || input.device_id || input.device?.id),
    date: cleanText(input.date),
    payload: input.payload || input
  }));
}

export function normalizeHealthSnapshot(input = {}) {
  const sleep = input.sleep || input.sleepSession || {};
  const heart = input.heart || input.heartRate || {};
  const workout = input.workout || input.workoutSession || input.exercise || {};
  const body = input.body || input.bodyMeasurements || {};
  const activity = input.activity || input.dailyActivity || {};
  const timezone = cleanText(input.timezone) || DEFAULT_TIMEZONE;
  const date = cleanText(input.date || input.day || input.recordedAt || input.recorded_at);

  return {
    schemaVersion: LIFE_DATA_SCHEMA_VERSION,
    source: cleanText(input.source) || 'health_connect',
    sourceRecordId: cleanText(input.sourceRecordId || input.source_record_id),
    recordType: 'health_daily_snapshot',
    device: {
      id: cleanText(input.deviceId || input.device_id || input.device?.id) || 'unknown-device',
      model: cleanText(input.deviceModel || input.device_model || input.device?.model),
      manufacturer: cleanText(input.deviceManufacturer || input.device?.manufacturer)
    },
    date,
    timezone,
    metrics: {
      steps: toNumber(input.steps ?? activity.steps ?? input.stepCount),
      distanceMeters: toNumber(input.distanceMeters ?? activity.distanceMeters ?? workout.distanceMeters),
      activeMinutes: toNumber(input.activeMinutes ?? activity.activeMinutes ?? workout.durationMinutes),
      activeCalories: toNumber(input.activeCalories ?? activity.activeCalories ?? input.caloriesOut),
      totalCalories: toNumber(input.totalCalories ?? activity.totalCalories),
      sleepMinutes: toNumber(input.sleepMinutes ?? sleep.durationMinutes ?? sleep.totalMinutes),
      deepSleepMinutes: toNumber(input.deepSleepMinutes ?? sleep.deepMinutes),
      remSleepMinutes: toNumber(input.remSleepMinutes ?? sleep.remMinutes),
      awakeMinutes: toNumber(input.awakeMinutes ?? sleep.awakeMinutes),
      restingHeartRate: toNumber(input.restingHeartRate ?? heart.resting ?? heart.restingBpm),
      avgHeartRate: toNumber(input.avgHeartRate ?? heart.avg ?? heart.averageBpm ?? workout.avgHeartRate),
      maxHeartRate: toNumber(input.maxHeartRate ?? heart.max ?? heart.maxBpm ?? workout.maxHeartRate),
      workoutMinutes: toNumber(input.workoutMinutes ?? workout.durationMinutes ?? workout.minutes),
      workoutCalories: toNumber(input.workoutCalories ?? workout.calories),
      workoutDistanceMeters: toNumber(input.workoutDistanceMeters ?? workout.distanceMeters),
      weightKg: toNumber(input.weightKg ?? body.weightKg ?? input.weight),
      spo2: toNumber(input.spo2 ?? input.bloodOxygen ?? body.spo2),
      stress: toNumber(input.stress ?? body.stress)
    },
    intervals: {
      sleepStart: cleanText(input.sleepStart ?? sleep.start ?? sleep.startTime),
      sleepEnd: cleanText(input.sleepEnd ?? sleep.end ?? sleep.endTime),
      workoutType: cleanText(input.workoutType ?? workout.type ?? workout.sport),
      workoutStart: cleanText(input.workoutStart ?? workout.start ?? workout.startTime),
      workoutEnd: cleanText(input.workoutEnd ?? workout.end ?? workout.endTime)
    },
    quality: assessHealthSnapshotQuality(input),
    raw: input
  };
}

export function assessHealthSnapshotQuality(input = {}) {
  const issues = [];
  const steps = toNumber(input.steps ?? input.activity?.steps);
  const sleepMinutes = toNumber(input.sleepMinutes ?? input.sleep?.durationMinutes);
  const avgHeartRate = toNumber(input.avgHeartRate ?? input.heartRate?.averageBpm);
  const weightKg = toNumber(input.weightKg ?? input.body?.weightKg);

  if (steps < 0) issues.push('steps_negative');
  if (steps > 100000) issues.push('steps_extreme');
  if (sleepMinutes < 0 || sleepMinutes > 1200) issues.push('sleep_minutes_implausible');
  if (avgHeartRate && (avgHeartRate < 30 || avgHeartRate > 220)) issues.push('avg_heart_rate_implausible');
  if (weightKg && (weightKg < 25 || weightKg > 350)) issues.push('weight_kg_implausible');
  if (!cleanText(input.date || input.day || input.recordedAt || input.recorded_at)) issues.push('date_missing');

  return {
    status: issues.length ? 'suspected' : 'valid',
    issues
  };
}

export function buildCanonicalMeasurements(snapshot) {
  const date = cleanText(snapshot.date);
  const startTime = date ? `${date}T00:00:00-03:00` : new Date().toISOString();
  const source = snapshot.source;
  const deviceId = snapshot.device?.id || '';
  const timezone = snapshot.timezone || DEFAULT_TIMEZONE;
  const metricMap = [
    ['steps', 'count'],
    ['distanceMeters', 'm'],
    ['activeMinutes', 'min'],
    ['activeCalories', 'kcal'],
    ['totalCalories', 'kcal'],
    ['sleepMinutes', 'min'],
    ['deepSleepMinutes', 'min'],
    ['remSleepMinutes', 'min'],
    ['awakeMinutes', 'min'],
    ['restingHeartRate', 'bpm'],
    ['avgHeartRate', 'bpm'],
    ['maxHeartRate', 'bpm'],
    ['workoutMinutes', 'min'],
    ['workoutCalories', 'kcal'],
    ['workoutDistanceMeters', 'm'],
    ['weightKg', 'kg'],
    ['spo2', '%'],
    ['stress', 'score']
  ];

  return metricMap
    .map(([metric, unit]) => ({
      source,
      deviceId,
      metric,
      value: toNumber(snapshot.metrics?.[metric]),
      unit,
      startTime,
      endTime: null,
      timezone,
      qualityStatus: snapshot.quality?.status || 'valid',
      metadata: {}
    }))
    .filter(row => row.value !== 0);
}

export function buildDailySummary(snapshot) {
  const m = snapshot.metrics || {};
  return {
    date: snapshot.date,
    timezone: snapshot.timezone || DEFAULT_TIMEZONE,
    sourceResolution: 'single_source_snapshot',
    steps: Math.round(toNumber(m.steps)),
    distanceM: toNumber(m.distanceMeters),
    activeMinutes: Math.round(toNumber(m.activeMinutes)),
    activeCalories: toNumber(m.activeCalories),
    totalCalories: toNumber(m.totalCalories),
    sleepMinutes: Math.round(toNumber(m.sleepMinutes)),
    deepSleepMinutes: Math.round(toNumber(m.deepSleepMinutes)),
    remSleepMinutes: Math.round(toNumber(m.remSleepMinutes)),
    awakeMinutes: Math.round(toNumber(m.awakeMinutes)),
    restingHr: toNumber(m.restingHeartRate) || null,
    avgHr: toNumber(m.avgHeartRate) || null,
    maxHr: toNumber(m.maxHeartRate) || null,
    weightKg: toNumber(m.weightKg) || null,
    workoutsCount: toNumber(m.workoutMinutes) > 0 ? 1 : 0,
    workoutMinutes: Math.round(toNumber(m.workoutMinutes)),
    qualityStatus: snapshot.quality?.status || 'valid',
    sources: {
      primary: snapshot.source,
      deviceId: snapshot.device?.id || ''
    }
  };
}

export function normalizeBodyActivity(input = {}) {
  const performance = input.performance || {};
  const cardio = input.cardio || input.heartRate || {};
  const biomechanics = input.biomechanics || input.runningDynamics || {};
  const training = input.training || {};
  const energy = input.energy || {};
  const timezone = cleanText(input.timezone) || DEFAULT_TIMEZONE;
  const activityType = cleanText(input.activityType || input.activity_type || input.type) || 'activity';
  const distanceKm = toNumber(input.distanceKm ?? input.distance_km ?? performance.distanceKm);
  const distanceMeters = toNumber(input.distanceMeters ?? input.distance_meters ?? performance.distanceMeters) || distanceKm * 1000;
  const durationSeconds = toNumber(input.durationSeconds ?? input.duration_seconds ?? performance.durationSeconds);
  const avgPaceSecKm = toNumber(input.averagePaceSecKm ?? input.average_pace_sec_km ?? performance.averagePaceSecKm) ||
    (distanceMeters && durationSeconds ? durationSeconds / (distanceMeters / 1000) : 0);
  const avgSpeedKmh = toNumber(input.averageSpeedKmh ?? input.average_speed_kmh ?? performance.averageSpeedKmh) ||
    (durationSeconds && distanceMeters ? (distanceMeters / 1000) / (durationSeconds / 3600) : 0);
  const avgHr = toNumber(input.averageHeartRateBpm ?? input.average_heart_rate_bpm ?? cardio.averageBpm ?? cardio.avgHeartRate);

  return {
    schemaVersion: LIFE_DATA_SCHEMA_VERSION,
    source: cleanText(input.source) || 'radar_body_activity',
    sourceRecordId: cleanText(input.sourceRecordId || input.source_record_id),
    activityType,
    subtype: cleanText(input.subtype || input.sport || activityType),
    title: cleanText(input.title || input.titulo) || activityType,
    date: cleanText(input.date || input.day || input.data),
    startTime: cleanText(input.startTime || input.start_time || input.startedAt),
    endTime: cleanText(input.endTime || input.end_time || input.endedAt),
    timezone,
    metrics: {
      distanceMeters,
      durationSeconds,
      averagePaceSecKm: avgPaceSecKm,
      bestPaceSecKm: toNumber(input.bestPaceSecKm ?? input.best_pace_sec_km ?? performance.bestPaceSecKm),
      averageSpeedKmh: avgSpeedKmh,
      maxSpeedKmh: toNumber(input.maxSpeedKmh ?? input.max_speed_kmh ?? performance.maxSpeedKmh),
      averageCadenceSpm: toNumber(input.averageCadenceSpm ?? input.average_cadence_spm ?? biomechanics.averageCadenceSpm),
      maxCadenceSpm: toNumber(input.maxCadenceSpm ?? input.max_cadence_spm ?? biomechanics.maxCadenceSpm),
      averageStrideCm: toNumber(input.averageStrideCm ?? input.average_stride_cm ?? biomechanics.averageStrideCm),
      verticalOscillationCm: toNumber(input.verticalOscillationCm ?? input.vertical_oscillation_cm ?? biomechanics.verticalOscillationCm),
      verticalRatioPercent: toNumber(input.verticalRatioPercent ?? input.vertical_ratio_percent ?? biomechanics.verticalRatioPercent),
      groundContactTimeMs: toNumber(input.groundContactTimeMs ?? input.ground_contact_time_ms ?? biomechanics.groundContactTimeMs),
      steps: toNumber(input.steps ?? input.passos),
      caloriesKcal: toNumber(input.caloriesKcal ?? input.calories_kcal ?? energy.caloriesKcal),
      averageHeartRateBpm: avgHr,
      maxHeartRateBpm: toNumber(input.maxHeartRateBpm ?? input.max_heart_rate_bpm ?? cardio.maxBpm),
      minHeartRateBpm: toNumber(input.minHeartRateBpm ?? input.min_heart_rate_bpm ?? cardio.minBpm),
      aerobicTrainingEffect: toNumber(input.aerobicTrainingEffect ?? input.aerobic_training_effect ?? training.aerobicTrainingEffect),
      anaerobicTrainingEffect: toNumber(input.anaerobicTrainingEffect ?? input.anaerobic_training_effect ?? training.anaerobicTrainingEffect),
      trainingLoad: toNumber(input.trainingLoad ?? input.training_load ?? training.trainingLoad),
      aerobicEfficiency: avgHr && avgSpeedKmh ? avgSpeedKmh / avgHr : 0
    },
    quality: assessBodyActivityQuality(input),
    raw: input
  };
}

export function assessBodyActivityQuality(input = {}) {
  const issues = [];
  const type = cleanText(input.activityType || input.activity_type || input.type);
  const distanceKm = toNumber(input.distanceKm ?? input.distance_km);
  const durationSeconds = toNumber(input.durationSeconds ?? input.duration_seconds);
  const avgHr = toNumber(input.averageHeartRateBpm ?? input.average_heart_rate_bpm);

  if (!type) issues.push('activity_type_missing');
  if (distanceKm < 0 || distanceKm > 300) issues.push('distance_implausible');
  if (durationSeconds < 0 || durationSeconds > 86400) issues.push('duration_implausible');
  if (avgHr && (avgHr < 30 || avgHr > 230)) issues.push('heart_rate_implausible');

  return {
    status: issues.length ? 'suspected' : 'valid',
    issues
  };
}
