export function createLifeDataRepository(db) {
  return {
    persistIngestionPlan: (plan, options) => persistIngestionPlan(db, plan, options)
  };
}

export async function persistIngestionPlan(db, plan, options = {}) {
  validatePlan(plan);

  const client = await acquireClient(db);
  const release = typeof client.release === 'function' && client !== db
    ? () => client.release()
    : () => {};

  try {
    await client.query('begin');

    const source = await upsertDataSource(client, {
      sourceKey: plan.rawRecord.sourceKey || plan.source,
      sourceType: options.sourceType || inferSourceType(plan),
      displayName: options.displayName || plan.rawRecord.sourceKey || plan.source,
      provider: options.provider || plan.source,
      metadata: { schemaVersion: plan.schemaVersion }
    });

    const device = await upsertDevice(client, {
      sourceId: source.id,
      deviceKey: plan.rawRecord.deviceKey,
      device: plan.rawRecord.metadata?.device
    });

    const rawRecord = await upsertRawRecord(client, {
      sourceId: source.id,
      deviceId: device?.id,
      rawRecord: plan.rawRecord
    });

    const canonical = await persistCanonicalDrafts(client, {
      sourceId: source.id,
      deviceId: device?.id,
      rawRecordId: rawRecord.id,
      canonical: plan.canonical || {}
    });

    await client.query('commit');

    return {
      ok: true,
      sourceId: source.id,
      deviceId: device?.id || null,
      rawRecordId: rawRecord.id,
      fingerprint: plan.fingerprint || plan.rawRecord.payloadChecksum,
      operations: plan.operations,
      canonical
    };
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // Keep the original persistence error as the failure signal.
    }
    throw error;
  } finally {
    release();
  }
}

export async function persistCanonicalDrafts(client, context) {
  const canonical = context.canonical || {};
  const healthMeasurements = await insertHealthMeasurements(client, context, canonical.healthMeasurements || []);
  const healthDaily = canonical.healthDaily
    ? await upsertHealthDaily(client, context, canonical.healthDaily)
    : null;
  const bodyActivities = await insertBodyActivities(client, context, canonical.bodyActivities || []);

  const semanticEvents = [];
  for (const event of canonical.semanticEvents || []) {
    semanticEvents.push(await insertSemanticEvent(client, context, event));
  }

  const semanticEventId = semanticEvents[0]?.id || null;
  const financialEvents = await insertChildEvents(
    client,
    'financial_events',
    semanticEventId,
    canonical.financialEvents || [],
    insertFinancialEvent
  );
  const nutritionEvents = await insertChildEvents(
    client,
    'nutrition_events',
    semanticEventId,
    canonical.nutritionEvents || [],
    insertNutritionEvent
  );
  const missionEvents = await insertChildEvents(
    client,
    'mission_events',
    semanticEventId,
    canonical.missionEvents || [],
    insertMissionEvent
  );

  return {
    healthMeasurements,
    healthDaily,
    bodyActivities,
    semanticEvents,
    financialEvents,
    nutritionEvents,
    missionEvents
  };
}

async function insertBodyActivities(client, context, activities) {
  const rows = [];
  for (const activity of activities) {
    const m = activity.metrics || {};
    const result = await client.query(
      `insert into body_activities
        (raw_record_id, source_id, device_id, activity_key, activity_type, subtype,
         title, date, start_time, end_time, timezone, distance_m, duration_seconds,
         average_pace_sec_km, best_pace_sec_km, average_speed_kmh, max_speed_kmh,
         average_cadence_spm, max_cadence_spm, average_stride_cm,
         vertical_oscillation_cm, vertical_ratio_percent, ground_contact_time_ms,
         steps, calories_kcal, average_heart_rate_bpm, max_heart_rate_bpm,
         min_heart_rate_bpm, aerobic_training_effect, anaerobic_training_effect,
         training_load, aerobic_efficiency, quality_status, metadata)
       values ($1, $2, $3, coalesce($4, $5 || ':' || coalesce($8::text, '') || ':' || coalesce($10::text, '') || ':' || $13::text),
         $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31,
         $32, $33, $34::jsonb)
       on conflict (source_id, activity_key) do update set
         title = coalesce(excluded.title, body_activities.title),
         distance_m = coalesce(excluded.distance_m, body_activities.distance_m),
         duration_seconds = coalesce(excluded.duration_seconds, body_activities.duration_seconds),
         average_pace_sec_km = coalesce(excluded.average_pace_sec_km, body_activities.average_pace_sec_km),
         average_heart_rate_bpm = coalesce(excluded.average_heart_rate_bpm, body_activities.average_heart_rate_bpm),
         metadata = body_activities.metadata || excluded.metadata
       returning id, activity_type`,
      [
        context.rawRecordId,
        context.sourceId,
        context.deviceId || null,
        nullIfEmpty(activity.sourceRecordId),
        activity.activityType || 'activity',
        nullIfEmpty(activity.subtype),
        nullIfEmpty(activity.title),
        dateOrNull(activity.date),
        nullIfEmpty(activity.startTime),
        nullIfEmpty(activity.endTime),
        nullIfEmpty(activity.timezone),
        numberOrNull(m.distanceMeters),
        integerOrNull(m.durationSeconds),
        numberOrNull(m.averagePaceSecKm),
        numberOrNull(m.bestPaceSecKm),
        numberOrNull(m.averageSpeedKmh),
        numberOrNull(m.maxSpeedKmh),
        numberOrNull(m.averageCadenceSpm),
        numberOrNull(m.maxCadenceSpm),
        numberOrNull(m.averageStrideCm),
        numberOrNull(m.verticalOscillationCm),
        numberOrNull(m.verticalRatioPercent),
        numberOrNull(m.groundContactTimeMs),
        integerOrNull(m.steps),
        numberOrNull(m.caloriesKcal),
        numberOrNull(m.averageHeartRateBpm),
        numberOrNull(m.maxHeartRateBpm),
        numberOrNull(m.minHeartRateBpm),
        numberOrNull(m.aerobicTrainingEffect),
        numberOrNull(m.anaerobicTrainingEffect),
        numberOrNull(m.trainingLoad),
        numberOrNull(m.aerobicEfficiency),
        activity.quality?.status || 'valid',
        jsonParam({ raw: activity.raw, quality: activity.quality })
      ]
    );
    rows.push(firstRow(result, 'body_activity'));
  }
  return rows;
}

async function acquireClient(db) {
  if (!db) {
    throw new Error('Life Data repository requires a db client or pool.');
  }
  if (typeof db.connect === 'function') return db.connect();
  if (typeof db.query === 'function') return db;
  throw new Error('Life Data repository db must expose query(sql, params) or connect().');
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Invalid Life Data ingestion plan: object_required');
  }
  if (!plan.rawRecord || typeof plan.rawRecord !== 'object') {
    throw new Error('Invalid Life Data ingestion plan: raw_record_required');
  }
  if (!plan.rawRecord.sourceKey && !plan.source) {
    throw new Error('Invalid Life Data ingestion plan: source_required');
  }
  if (!plan.rawRecord.sourceRecordType) {
    throw new Error('Invalid Life Data ingestion plan: source_record_type_required');
  }
  if (!plan.rawRecord.payloadChecksum) {
    throw new Error('Invalid Life Data ingestion plan: payload_checksum_required');
  }
}

function inferSourceType(plan) {
  if (plan.recordType === 'health_daily_snapshot') return 'health';
  if (plan.recordType === 'semantic_event') return 'semantic';
  return 'unknown';
}

async function upsertDataSource(client, source) {
  const result = await client.query(
    `insert into data_sources
      (source_key, source_type, display_name, provider, metadata)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (source_key) do update set
      source_type = excluded.source_type,
      display_name = excluded.display_name,
      provider = excluded.provider,
      updated_at = now(),
      metadata = data_sources.metadata || excluded.metadata
     returning id`,
    [
      source.sourceKey,
      source.sourceType,
      source.displayName,
      source.provider,
      jsonParam(source.metadata)
    ]
  );
  return firstRow(result, 'data_source');
}

async function upsertDevice(client, { sourceId, deviceKey, device = {} }) {
  if (!deviceKey || deviceKey === 'unknown-device') {
    return { id: null };
  }

  const result = await client.query(
    `insert into devices
      (source_id, device_key, model, manufacturer, last_seen_at, metadata)
     values ($1, $2, $3, $4, now(), $5::jsonb)
     on conflict (source_id, device_key) do update set
      model = coalesce(excluded.model, devices.model),
      manufacturer = coalesce(excluded.manufacturer, devices.manufacturer),
      last_seen_at = now(),
      metadata = devices.metadata || excluded.metadata
     returning id`,
    [
      sourceId,
      deviceKey,
      nullIfEmpty(device.model),
      nullIfEmpty(device.manufacturer),
      jsonParam(device)
    ]
  );
  return firstRow(result, 'device');
}

async function upsertRawRecord(client, { sourceId, deviceId, rawRecord }) {
  const result = await client.query(
    `insert into raw_records
      (source_id, device_id, source_record_id, source_record_type, occurred_at,
       start_time, end_time, timezone, payload, payload_checksum, schema_version,
       quality_status, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb)
     on conflict (source_id, payload_checksum) do update set
      source_record_id = coalesce(excluded.source_record_id, raw_records.source_record_id),
      source_record_type = excluded.source_record_type,
      occurred_at = coalesce(excluded.occurred_at, raw_records.occurred_at),
      start_time = coalesce(excluded.start_time, raw_records.start_time),
      end_time = coalesce(excluded.end_time, raw_records.end_time),
      timezone = coalesce(excluded.timezone, raw_records.timezone),
      payload = excluded.payload,
      quality_status = excluded.quality_status,
      metadata = raw_records.metadata || excluded.metadata
     returning id`,
    [
      sourceId,
      deviceId || null,
      nullIfEmpty(rawRecord.sourceRecordId),
      rawRecord.sourceRecordType,
      nullIfEmpty(rawRecord.occurredAt),
      nullIfEmpty(rawRecord.startTime),
      nullIfEmpty(rawRecord.endTime),
      nullIfEmpty(rawRecord.timezone),
      jsonParam(rawRecord.payload),
      rawRecord.payloadChecksum,
      rawRecord.schemaVersion || 'life_data_v1',
      rawRecord.qualityStatus || 'valid',
      jsonParam(rawRecord.metadata)
    ]
  );
  return firstRow(result, 'raw_record');
}

async function insertHealthMeasurements(client, context, measurements) {
  const rows = [];
  for (const measurement of measurements) {
    const result = await client.query(
      `insert into health_measurements
        (raw_record_id, source_id, device_id, metric, value_numeric, value_text, unit,
         start_time, end_time, timezone, recording_method, confidence, quality_status, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
       returning id, metric`,
      [
        context.rawRecordId,
        context.sourceId,
        context.deviceId || null,
        measurement.metric,
        numberOrNull(measurement.valueNumeric),
        nullIfEmpty(measurement.valueText),
        nullIfEmpty(measurement.unit),
        measurement.startTime,
        nullIfEmpty(measurement.endTime),
        nullIfEmpty(measurement.timezone),
        nullIfEmpty(measurement.recordingMethod),
        numberOrNull(measurement.confidence),
        measurement.qualityStatus || 'valid',
        jsonParam(measurement.metadata)
      ]
    );
    rows.push(firstRow(result, 'health_measurement'));
  }
  return rows;
}

async function upsertHealthDaily(client, context, daily) {
  const result = await client.query(
    `insert into health_daily
      (date, timezone, source_resolution, steps, distance_m, active_minutes,
       active_calories, total_calories, sleep_minutes, deep_sleep_minutes,
       rem_sleep_minutes, awake_minutes, resting_hr, avg_hr, max_hr, weight_kg,
       workouts_count, workout_minutes, data_quality_score, quality_status, sources, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18, $19, $20, $21::jsonb, $22::jsonb)
     on conflict (date, timezone, source_resolution) do update set
      steps = coalesce(excluded.steps, health_daily.steps),
      distance_m = coalesce(excluded.distance_m, health_daily.distance_m),
      active_minutes = coalesce(excluded.active_minutes, health_daily.active_minutes),
      active_calories = coalesce(excluded.active_calories, health_daily.active_calories),
      total_calories = coalesce(excluded.total_calories, health_daily.total_calories),
      sleep_minutes = coalesce(excluded.sleep_minutes, health_daily.sleep_minutes),
      deep_sleep_minutes = coalesce(excluded.deep_sleep_minutes, health_daily.deep_sleep_minutes),
      rem_sleep_minutes = coalesce(excluded.rem_sleep_minutes, health_daily.rem_sleep_minutes),
      awake_minutes = coalesce(excluded.awake_minutes, health_daily.awake_minutes),
      resting_hr = coalesce(excluded.resting_hr, health_daily.resting_hr),
      avg_hr = coalesce(excluded.avg_hr, health_daily.avg_hr),
      max_hr = coalesce(excluded.max_hr, health_daily.max_hr),
      weight_kg = coalesce(excluded.weight_kg, health_daily.weight_kg),
      workouts_count = greatest(health_daily.workouts_count, excluded.workouts_count),
      workout_minutes = greatest(health_daily.workout_minutes, excluded.workout_minutes),
      data_quality_score = coalesce(excluded.data_quality_score, health_daily.data_quality_score),
      quality_status = excluded.quality_status,
      sources = health_daily.sources || excluded.sources,
      metadata = health_daily.metadata || excluded.metadata,
      computed_at = now()
     returning id, date`,
    [
      daily.date,
      daily.timezone,
      daily.sourceResolution || 'resolved_primary',
      integerOrNull(daily.steps),
      numberOrNull(daily.distanceM),
      integerOrNull(daily.activeMinutes),
      numberOrNull(daily.activeCalories),
      numberOrNull(daily.totalCalories),
      integerOrNull(daily.sleepMinutes),
      integerOrNull(daily.deepSleepMinutes),
      integerOrNull(daily.remSleepMinutes),
      integerOrNull(daily.awakeMinutes),
      numberOrNull(daily.restingHr),
      numberOrNull(daily.avgHr),
      numberOrNull(daily.maxHr),
      numberOrNull(daily.weightKg),
      integerOrNull(daily.workoutsCount) || 0,
      integerOrNull(daily.workoutMinutes) || 0,
      integerOrNull(daily.dataQualityScore),
      daily.qualityStatus || 'valid',
      jsonParam({ rawRecordId: context.rawRecordId, sourceId: context.sourceId }),
      jsonParam(daily.metadata)
    ]
  );
  return firstRow(result, 'health_daily');
}

async function insertSemanticEvent(client, context, event) {
  const result = await client.query(
    `insert into semantic_events
      (raw_record_id, legacy_entry_id, source_id, occurred_at, date_hint, timezone,
       original_text, event_type, domain, title, status, confidence, extracted_facts,
       metrics, tags, people, places, assets, quality_status, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
       $14::jsonb, $15, $16::jsonb, $17::jsonb, $18::jsonb, $19, $20::jsonb)
     returning id, title`,
    [
      context.rawRecordId,
      nullIfEmpty(event.legacyEntryId),
      context.sourceId,
      nullIfEmpty(event.occurredAt),
      dateOrNull(event.dateHint),
      nullIfEmpty(event.timezone),
      nullIfEmpty(event.originalText),
      nullIfEmpty(event.eventType),
      nullIfEmpty(event.domain),
      nullIfEmpty(event.title),
      nullIfEmpty(event.status),
      numberOrNull(event.confidence),
      jsonParam(event.extractedFacts),
      jsonParam(event.metrics),
      textArrayParam(event.tags),
      jsonParam(event.people || []),
      jsonParam(event.places || []),
      jsonParam(event.assets || []),
      event.qualityStatus || 'valid',
      jsonParam(event.metadata)
    ]
  );
  return firstRow(result, 'semantic_event');
}

async function insertChildEvents(client, tableName, semanticEventId, events, inserter) {
  const rows = [];
  for (const event of events) {
    rows.push(await inserter(client, semanticEventId, event));
  }
  return rows.map(row => ({ ...row, tableName }));
}

async function insertFinancialEvent(client, semanticEventId, event) {
  const result = await client.query(
    `insert into financial_events
      (semantic_event_id, occurred_at, event_type, amount, currency, asset_ticker,
       asset_quantity, unit_price, broker, counterparty, category, confidence, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     returning id, event_type`,
    [
      semanticEventId,
      nullIfEmpty(event.occurredAt),
      event.eventType,
      numberOrNull(event.amount),
      event.currency || 'BRL',
      nullIfEmpty(event.assetTicker),
      numberOrNull(event.assetQuantity),
      numberOrNull(event.unitPrice),
      nullIfEmpty(event.broker),
      nullIfEmpty(event.counterparty),
      nullIfEmpty(event.category),
      numberOrNull(event.confidence),
      jsonParam(event.metadata)
    ]
  );
  return firstRow(result, 'financial_event');
}

async function insertNutritionEvent(client, semanticEventId, event) {
  const result = await client.query(
    `insert into nutrition_events
      (semantic_event_id, occurred_at, meal_type, description, calories_estimated,
       protein_g, carbs_g, fat_g, fiber_g, sodium_mg, confidence, missing_fields, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     returning id, meal_type`,
    [
      semanticEventId,
      nullIfEmpty(event.occurredAt),
      nullIfEmpty(event.mealType),
      nullIfEmpty(event.description),
      numberOrNull(event.caloriesEstimated),
      numberOrNull(event.proteinG),
      numberOrNull(event.carbsG),
      numberOrNull(event.fatG),
      numberOrNull(event.fiberG),
      numberOrNull(event.sodiumMg),
      numberOrNull(event.confidence),
      textArrayParam(event.missingFields),
      jsonParam(event.metadata)
    ]
  );
  return firstRow(result, 'nutrition_event');
}

async function insertMissionEvent(client, semanticEventId, event) {
  const result = await client.query(
    `insert into mission_events
      (semantic_event_id, mission_key, title, intent, status, priority, due_date,
       next_action, confidence, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     returning id, mission_key`,
    [
      semanticEventId,
      event.missionKey,
      event.title,
      event.intent || 'create',
      nullIfEmpty(event.status),
      nullIfEmpty(event.priority),
      dateOrNull(event.dueDate),
      nullIfEmpty(event.nextAction),
      numberOrNull(event.confidence),
      jsonParam(event.metadata)
    ]
  );
  return firstRow(result, 'mission_event');
}

function firstRow(result, label) {
  const row = result?.rows?.[0];
  if (row?.id !== undefined) return row;
  throw new Error(`Life Data repository did not receive an id for ${label}.`);
}

function jsonParam(value) {
  return JSON.stringify(value ?? {});
}

function textArrayParam(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function nullIfEmpty(value) {
  if (value === undefined || value === null || value === '') return null;
  return value;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = numberOrNull(value);
  return number === null ? null : Math.round(number);
}

function dateOrNull(value) {
  const text = nullIfEmpty(value);
  if (!text) return null;
  const match = String(text).match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}
