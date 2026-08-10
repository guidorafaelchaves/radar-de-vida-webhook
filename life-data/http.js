import { processLifeDataIngestion } from './engine.js';

export function buildLifeDataStatusHttpResponse(options = {}) {
  const env = options.env || process.env;
  const flags = options.lifeDataFlags || {};
  const databaseUrl = clean(env.LIFE_DATA_DATABASE_URL || env.DATABASE_URL);

  return {
    status: 200,
    body: {
      ok: true,
      service: 'life-data-engine',
      mode: lifeDataRuntimeMode(flags),
      now: options.now || new Date().toISOString(),
      siteUrl: options.siteUrl || null,
      endpoints: {
        status: '/api/life-data/status',
        plan: '/api/life-data/plan'
      },
      flags,
      storage: {
        configured: Boolean(databaseUrl),
        adapter: 'postgres',
        package: 'pg',
        packageRequiredOnlyForStorage: true,
        writeThroughEnabled: Boolean(flags.writeThrough)
      },
      safety: {
        productionFlowsChanged: false,
        writesRequireFlags: [
          'LIFE_DATA_ENGINE_ENABLED',
          'LIFE_DATA_INGESTION_ENABLED',
          'LIFE_DATA_STORAGE_ENABLED',
          'LIFE_DATA_WRITE_THROUGH_ENABLED'
        ],
        currentWritePath: Boolean(flags.storage && flags.writeThrough)
          ? 'write_through_possible'
          : 'plan_only_or_disabled'
      },
      commands: {
        test: 'npm run test:life-data',
        migrationPlan: 'npm run life-data:migrations:plan',
        migrationDryRun: 'npm run life-data:migrations:dry-run',
        migrationRun: 'LIFE_DATA_CONFIRM_RUN=yes npm run life-data:migrations:run'
      }
    }
  };
}

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

function lifeDataRuntimeMode(flags = {}) {
  if (!flags.engine || !flags.ingestion) return 'disabled';
  if (flags.storage && flags.writeThrough) return 'write_through_armed';
  return 'plan_only';
}

function clean(value) {
  return String(value || '').trim();
}
