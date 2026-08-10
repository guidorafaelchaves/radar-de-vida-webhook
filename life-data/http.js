import { processLifeDataIngestion } from './engine.js';

export async function buildLifeDataPlanHttpResponse(input = {}, options = {}) {
  const runIngestion = options.processLifeDataIngestion || processLifeDataIngestion;

  try {
    const result = await runIngestion(input, {
      env: options.env,
      db: options.db,
      config: options.config,
      databaseConfig: options.databaseConfig,
      pgLoader: options.pgLoader,
      repositoryOptions: options.repositoryOptions
    });

    return {
      status: 200,
      body: {
        ok: true,
        mode: result.mode,
        persisted: result.persisted,
        lifeDataFlags: options.lifeDataFlags || null,
        storage: result.storage,
        plan: result.plan
      }
    };
  } catch (error) {
    return buildLifeDataErrorResponse(error, options);
  }
}

export function buildLifeDataErrorResponse(error, options = {}) {
  if (error?.code === 'LIFE_DATA_INGESTION_DISABLED') {
    return {
      status: 404,
      body: {
        ok: false,
        error: options.disabledMessage || 'Life Data ingestion desativado por feature flag.',
        code: error.code,
        requiredFlags: error.requiredFlags || {
          LIFE_DATA_ENGINE_ENABLED: true,
          LIFE_DATA_INGESTION_ENABLED: true
        }
      }
    };
  }

  return {
    status: 400,
    body: {
      ok: false,
      error: error?.message || 'Life Data plan error.',
      code: error?.code || 'LIFE_DATA_PLAN_ERROR',
      errors: Array.isArray(error?.errors) ? error.errors : []
    }
  };
}
