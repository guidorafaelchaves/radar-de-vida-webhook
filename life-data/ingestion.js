import {
  DEFAULT_TIMEZONE,
  LIFE_DATA_SCHEMA_VERSION,
  buildCanonicalMeasurements,
  buildDailySummary,
  buildRawRecordFingerprint,
  cleanText,
  normalizeBodyActivity,
  normalizeHealthSnapshot,
  stableStringify,
  toNumber
} from './normalizers.js';

export const SUPPORTED_INGESTION_TYPES = new Set([
  'body_activity',
  'health_daily_snapshot',
  'semantic_event'
]);

export function normalizeIngestionEnvelope(input = {}) {
  const payload = input.payload && typeof input.payload === 'object'
    ? input.payload
    : input;
  const source = cleanText(input.source || payload.source) || 'unknown';
  const recordType = cleanText(input.recordType || input.record_type || payload.recordType || payload.record_type) || inferRecordType(payload);
  const timezone = cleanText(input.timezone || payload.timezone) || DEFAULT_TIMEZONE;

  return {
    schemaVersion: cleanText(input.schemaVersion || input.schema_version) || LIFE_DATA_SCHEMA_VERSION,
    source,
    sourceRecordId: cleanText(input.sourceRecordId || input.source_record_id || payload.sourceRecordId || payload.source_record_id),
    recordType,
    device: normalizeEnvelopeDevice(input.device || payload.device || payload),
    occurredAt: cleanText(input.occurredAt || input.occurred_at || payload.occurredAt || payload.occurred_at || payload.recordedAt),
    startTime: cleanText(input.startTime || input.start_time || payload.startTime || payload.start_time),
    endTime: cleanText(input.endTime || input.end_time || payload.endTime || payload.end_time),
    date: cleanText(input.date || payload.date || payload.day),
    timezone,
    recordingMethod: cleanText(input.recordingMethod || input.recording_method || payload.recordingMethod || payload.recording_method) || 'unknown',
    payload,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {}
  };
}

export function buildIngestionPlan(input = {}) {
  const envelope = normalizeIngestionEnvelope(input);
  validateIngestionEnvelope(envelope);

  const rawRecord = buildRawRecordDraft(envelope);
  const canonical = buildCanonicalDrafts(envelope);

  return {
    ok: true,
    schemaVersion: LIFE_DATA_SCHEMA_VERSION,
    source: envelope.source,
    recordType: envelope.recordType,
    fingerprint: rawRecord.payloadChecksum,
    rawRecord,
    canonical,
    operations: summarizePlannedOperations(rawRecord, canonical)
  };
}

export function validateIngestionEnvelope(envelope) {
  const errors = [];

  if (!cleanText(envelope.source)) errors.push('source_required');
  if (!cleanText(envelope.recordType)) errors.push('record_type_required');
  if (!SUPPORTED_INGESTION_TYPES.has(envelope.recordType)) errors.push(`unsupported_record_type:${envelope.recordType}`);
  if (!envelope.payload || typeof envelope.payload !== 'object') errors.push('payload_object_required');

  if (errors.length) {
    const err = new Error(`Invalid ingestion envelope: ${errors.join(', ')}`);
    err.code = 'INVALID_LIFE_DATA_INGESTION_ENVELOPE';
    err.errors = errors;
    throw err;
  }
}

export function buildRawRecordDraft(envelope) {
  const checksum = buildRawRecordFingerprint({
    source: envelope.source,
    sourceRecordId: envelope.sourceRecordId,
    recordType: envelope.recordType,
    startTime: envelope.startTime,
    endTime: envelope.endTime,
    deviceId: envelope.device.id,
    date: envelope.date,
    payload: envelope.payload
  });

  return {
    sourceKey: envelope.source,
    deviceKey: envelope.device.id,
    sourceRecordId: envelope.sourceRecordId,
    sourceRecordType: envelope.recordType,
    occurredAt: envelope.occurredAt || null,
    startTime: envelope.startTime || null,
    endTime: envelope.endTime || null,
    timezone: envelope.timezone,
    payload: envelope.payload,
    payloadChecksum: checksum,
    schemaVersion: envelope.schemaVersion,
    qualityStatus: 'valid',
    metadata: {
      ...envelope.metadata,
      recordingMethod: envelope.recordingMethod,
      device: envelope.device
    }
  };
}

export function buildCanonicalDrafts(envelope) {
  if (envelope.recordType === 'health_daily_snapshot') {
    return buildHealthCanonicalDrafts(envelope);
  }

  if (envelope.recordType === 'body_activity') {
    return buildBodyActivityCanonicalDrafts(envelope);
  }

  if (envelope.recordType === 'semantic_event') {
    return buildSemanticCanonicalDrafts(envelope);
  }

  return {
    healthMeasurements: [],
    healthDaily: null,
    bodyActivities: [],
    semanticEvents: [],
    financialEvents: [],
    nutritionEvents: [],
    missionEvents: []
  };
}

export function buildHealthCanonicalDrafts(envelope) {
  const snapshot = normalizeHealthSnapshot({
    ...envelope.payload,
    source: envelope.source,
    sourceRecordId: envelope.sourceRecordId,
    deviceId: envelope.device.id,
    deviceModel: envelope.device.model,
    deviceManufacturer: envelope.device.manufacturer,
    date: envelope.date || envelope.payload.date,
    timezone: envelope.timezone
  });

  return {
    healthSnapshot: snapshot,
    healthMeasurements: buildCanonicalMeasurements(snapshot),
    healthDaily: buildDailySummary(snapshot),
    bodyActivities: [],
    semanticEvents: [],
    financialEvents: [],
    nutritionEvents: [],
    missionEvents: []
  };
}

export function buildBodyActivityCanonicalDrafts(envelope) {
  const activity = normalizeBodyActivity({
    ...envelope.payload,
    source: envelope.source,
    sourceRecordId: envelope.sourceRecordId,
    deviceId: envelope.device.id,
    deviceModel: envelope.device.model,
    deviceManufacturer: envelope.device.manufacturer,
    date: envelope.date || envelope.payload.date,
    startTime: envelope.startTime || envelope.payload.startTime || envelope.payload.start_time,
    endTime: envelope.endTime || envelope.payload.endTime || envelope.payload.end_time,
    timezone: envelope.timezone
  });

  return {
    healthMeasurements: [],
    healthDaily: null,
    bodyActivities: [activity],
    semanticEvents: [],
    financialEvents: [],
    nutritionEvents: [],
    missionEvents: []
  };
}

export function buildSemanticCanonicalDrafts(envelope) {
  const payload = envelope.payload || {};
  const text = cleanText(payload.originalText || payload.text || payload.entrada_original);
  const intelligence = payload.radarIntelligence || payload.radar_intelligence || payload.structuredData || {};
  const legacyFields = payload.legacyFields || payload.legacy_fields || {};
  const eventType = cleanText(payload.eventType || payload.event_type || legacyFields.tipo_principal || intelligence.type) || 'life_event';
  const domain = cleanText(payload.domain || legacyFields.tipo_principal || inferSemanticDomain(text, intelligence));
  const occurredAt = envelope.occurredAt || cleanText(payload.data_iso) || null;

  const semanticEvent = {
    legacyEntryId: cleanText(payload.legacyEntryId || payload.legacy_entry_id || payload.id),
    sourceKey: envelope.source,
    occurredAt,
    dateHint: cleanText(payload.dateHint || payload.date_hint || payload.data_br || envelope.date),
    timezone: envelope.timezone,
    originalText: text,
    eventType,
    domain,
    title: cleanText(payload.title || payload.titulo || text.slice(0, 140)) || 'Semantic event',
    status: cleanText(payload.status) || 'observed',
    confidence: toNumber(payload.confidence || intelligence.confidence) || null,
    extractedFacts: payload.extractedFacts || payload.facts || {},
    metrics: buildSemanticMetrics(payload, legacyFields, intelligence),
    tags: normalizeTags(payload.tags || legacyFields.categorias || intelligence.tags),
    people: payload.people || legacyFields.pessoas_detectadas || [],
    places: payload.places || legacyFields.locais_detectados || [],
    assets: payload.assets || legacyFields.ativos_detectados || [],
    qualityStatus: 'valid',
    metadata: {
      sourceRecordId: envelope.sourceRecordId,
      rawIntelligencePresent: Boolean(Object.keys(intelligence || {}).length)
    }
  };

  return {
    healthMeasurements: [],
    healthDaily: null,
    bodyActivities: [],
    semanticEvents: [semanticEvent],
    financialEvents: buildFinancialEvents(semanticEvent),
    nutritionEvents: buildNutritionEvents(semanticEvent),
    missionEvents: buildMissionEvents(semanticEvent, intelligence)
  };
}

export function summarizePlannedOperations(rawRecord, canonical) {
  return {
    rawRecords: rawRecord ? 1 : 0,
    healthMeasurements: canonical.healthMeasurements?.length || 0,
    healthDaily: canonical.healthDaily ? 1 : 0,
    bodyActivities: canonical.bodyActivities?.length || 0,
    semanticEvents: canonical.semanticEvents?.length || 0,
    financialEvents: canonical.financialEvents?.length || 0,
    nutritionEvents: canonical.nutritionEvents?.length || 0,
    missionEvents: canonical.missionEvents?.length || 0
  };
}

function inferRecordType(payload = {}) {
  if (
    payload.activityType === 'running' ||
    payload.activity_type === 'running' ||
    payload.type === 'running' ||
    payload.distance_km !== undefined ||
    payload.average_pace_sec_km !== undefined
  ) {
    return 'body_activity';
  }

  if (
    payload.steps !== undefined ||
    payload.sleep !== undefined ||
    payload.heartRate !== undefined ||
    payload.activity !== undefined ||
    payload.workout !== undefined
  ) {
    return 'health_daily_snapshot';
  }

  return 'semantic_event';
}

function normalizeEnvelopeDevice(device = {}) {
  return {
    id: cleanText(device.id || device.deviceId || device.device_id) || cleanText(device.deviceId) || 'unknown-device',
    model: cleanText(device.model || device.deviceModel || device.device_model),
    manufacturer: cleanText(device.manufacturer || device.deviceManufacturer)
  };
}

function inferSemanticDomain(text, intelligence = {}) {
  const clean = cleanText(text).toLowerCase();
  if (/miss|tarefa|concluir|andamento/.test(clean)) return 'mission';
  if (/gastei|recebi|r\$|reais|aporte|dividendo|jcp|aluguel/.test(clean)) return 'finance';
  if (/comi|almo|janta|cafe|proteina|caloria/.test(clean)) return 'nutrition';
  if (/treino|caminh|corr|sono|peso|bpm/.test(clean)) return 'body';
  return cleanText(intelligence.domain) || 'timeline';
}

function buildSemanticMetrics(payload, legacyFields, intelligence) {
  const totals = intelligence.totals || {};
  return {
    moneySpent: toNumber(payload.moneySpent ?? legacyFields.dinheiro_gasto ?? totals.moneySpent),
    moneyEarned: toNumber(payload.moneyEarned ?? legacyFields.dinheiro_ganho ?? totals.moneyEarned),
    moneyInvested: toNumber(payload.moneyInvested ?? legacyFields.dinheiro_investido ?? totals.moneyInvested),
    passiveIncome: toNumber(payload.passiveIncome ?? legacyFields.renda_passiva ?? totals.passiveIncome),
    caloriesIn: toNumber(payload.caloriesIn ?? legacyFields.calorias_ingeridas ?? totals.caloriesIn),
    caloriesOut: toNumber(payload.caloriesOut ?? legacyFields.calorias_gastas ?? totals.caloriesOut),
    proteinG: toNumber(payload.proteinG ?? legacyFields.proteina_g ?? totals.proteinG),
    activityMinutes: toNumber(payload.activityMinutes ?? legacyFields.esporte_minutos ?? totals.activityMinutes)
  };
}

function normalizeTags(tags) {
  const arr = Array.isArray(tags) ? tags : [];
  return [...new Set(arr.map(cleanText).filter(Boolean))].slice(0, 20);
}

function buildFinancialEvents(semanticEvent) {
  const metrics = semanticEvent.metrics || {};
  const out = [];

  if (metrics.moneySpent) out.push(buildFinancialEvent(semanticEvent, 'expense', metrics.moneySpent));
  if (metrics.moneyEarned) out.push(buildFinancialEvent(semanticEvent, 'income', metrics.moneyEarned));
  if (metrics.moneyInvested) out.push(buildFinancialEvent(semanticEvent, 'investment_buy', metrics.moneyInvested));
  if (metrics.passiveIncome) out.push(buildFinancialEvent(semanticEvent, 'dividend', metrics.passiveIncome));

  return out;
}

function buildFinancialEvent(semanticEvent, eventType, amount) {
  return {
    semanticEventTitle: semanticEvent.title,
    occurredAt: semanticEvent.occurredAt,
    eventType,
    amount,
    currency: 'BRL',
    confidence: semanticEvent.confidence,
    metadata: {
      sourceDomain: semanticEvent.domain
    }
  };
}

function buildNutritionEvents(semanticEvent) {
  const metrics = semanticEvent.metrics || {};
  if (!metrics.caloriesIn && !metrics.proteinG) return [];

  return [{
    semanticEventTitle: semanticEvent.title,
    occurredAt: semanticEvent.occurredAt,
    mealType: 'unknown',
    description: semanticEvent.originalText,
    caloriesEstimated: metrics.caloriesIn || null,
    proteinG: metrics.proteinG || null,
    confidence: semanticEvent.confidence,
    missingFields: [],
    metadata: {}
  }];
}

function buildMissionEvents(semanticEvent, intelligence = {}) {
  const parser = intelligence.missionParser || intelligence.mission_parser;
  const looksMission = semanticEvent.domain === 'mission' || /\bmiss(?:ao|oes|ão|ões)\b/i.test(semanticEvent.originalText || '');

  if (!looksMission) return [];

  return [{
    semanticEventTitle: semanticEvent.title,
    missionKey: cleanText(parser?.missao_alvo_aproximada || parser?.title || semanticEvent.title)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'missao',
    title: cleanText(parser?.missao_alvo_aproximada || parser?.title || semanticEvent.title),
    intent: cleanText(parser?.intencao || parser?.intent || 'create').toLowerCase(),
    status: cleanText(parser?.status_sugerido || parser?.status || semanticEvent.status),
    priority: cleanText(parser?.prioridade || parser?.priority),
    nextAction: cleanText(parser?.conteudo_atualizacao || parser?.nextAction),
    confidence: semanticEvent.confidence,
    metadata: {}
  }];
}

export function serializeIngestionPlan(plan) {
  return stableStringify(plan);
}
