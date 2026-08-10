import { createLifeDataPool } from './database.js';
import { buildIngestionPlan } from './ingestion.js';
import { persistIngestionPlan } from './repository.js';

export function readLifeDataEngineConfig(env = process.env) {
  return {
    engineEnabled: envFlag(env.LIFE_DATA_ENGINE_ENABLED),
    ingestionEnabled: envFlag(env.LIFE_DATA_INGESTION_ENABLED),
    storageEnabled: envFlag(env.LIFE_DATA_STORAGE_ENABLED),
    writeThroughEnabled: envFlag(env.LIFE_DATA_WRITE_THROUGH_ENABLED),
    failOnStorageError: envFlag(env.LIFE_DATA_FAIL_ON_STORAGE_ERROR),
    debugLogs: envFlag(env.LIFE_DATA_DEBUG_LOGS)
  };
}

export async function processLifeDataIngestion(input, options = {}) {
  const config = options.config || readLifeDataEngineConfig(options.env);
  assertEngineCanPlan(config);

  const plan = options.plan || buildIngestionPlan(input);
  const shouldPersist = Boolean(config.storageEnabled && config.writeThroughEnabled);

  if (!shouldPersist) {
    return {
      ok: true,
      mode: 'plan_only',
      persisted: false,
      plan,
      storage: {
        attempted: false,
        reason: storageDisabledReason(config)
      }
    };
  }

  try {
    const persistence = await persistWithConfiguredStorage(plan, options);
    return {
      ok: true,
      mode: 'write_through',
      persisted: true,
      plan,
      storage: {
        attempted: true,
        result: persistence
      }
    };
  } catch (error) {
    if (config.failOnStorageError) throw error;
    return {
      ok: true,
      mode: 'plan_with_storage_warning',
      persisted: false,
      plan,
      storage: {
        attempted: true,
        error: {
          code: error.code || 'LIFE_DATA_STORAGE_ERROR',
          message: error.message,
          migrationName: error.migrationName
        }
      }
    };
  }
}

export function assertEngineCanPlan(config) {
  if (!config?.engineEnabled || !config?.ingestionEnabled) {
    const error = new Error('Life Data ingestion is disabled by feature flag.');
    error.code = 'LIFE_DATA_INGESTION_DISABLED';
    error.requiredFlags = {
      LIFE_DATA_ENGINE_ENABLED: true,
      LIFE_DATA_INGESTION_ENABLED: true
    };
    throw error;
  }
}

async function persistWithConfiguredStorage(plan, options) {
  if (options.db) {
    return persistIngestionPlan(options.db, plan, options.repositoryOptions);
  }

  const pool = await createLifeDataPool({
    env: options.env,
    config: options.databaseConfig,
    pgLoader: options.pgLoader
  });
  try {
    return await persistIngestionPlan(pool, plan, options.repositoryOptions);
  } finally {
    await pool.end();
  }
}

function storageDisabledReason(config) {
  if (!config.storageEnabled && !config.writeThroughEnabled) return 'storage_and_write_through_disabled';
  if (!config.storageEnabled) return 'storage_disabled';
  if (!config.writeThroughEnabled) return 'write_through_disabled';
  return 'unknown';
}

function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}
