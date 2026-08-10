export function readLifeDataDatabaseConfig(env = process.env) {
  const connectionString = clean(env.LIFE_DATA_DATABASE_URL || env.DATABASE_URL);

  return {
    connectionString,
    ssl: parseSsl(env.LIFE_DATA_DATABASE_SSL),
    max: parseInteger(env.LIFE_DATA_DATABASE_POOL_MAX, 3),
    idleTimeoutMillis: parseInteger(env.LIFE_DATA_DATABASE_IDLE_TIMEOUT_MS, 10_000),
    connectionTimeoutMillis: parseInteger(env.LIFE_DATA_DATABASE_CONNECTION_TIMEOUT_MS, 10_000)
  };
}

export async function createLifeDataPool(options = {}) {
  const config = options.config || readLifeDataDatabaseConfig(options.env);
  if (!config.connectionString) {
    throw new Error('LIFE_DATA_DATABASE_URL is required to connect the Life Data storage.');
  }

  const pg = await loadPg(options.pgLoader);
  return new pg.Pool({
    connectionString: config.connectionString,
    ssl: config.ssl,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis
  });
}

export async function withLifeDataPool(callback, options = {}) {
  const pool = await createLifeDataPool(options);
  try {
    return await callback(pool);
  } finally {
    await pool.end();
  }
}

async function loadPg(loader) {
  try {
    return loader ? await loader() : await import('pg');
  } catch (error) {
    const wrapped = new Error(
      'The Life Data database adapter requires the optional "pg" package. ' +
      'Install it only when you are ready to test Postgres storage.'
    );
    wrapped.cause = error;
    wrapped.code = 'LIFE_DATA_PG_PACKAGE_MISSING';
    throw wrapped;
  }
}

function parseSsl(value) {
  const text = clean(value).toLowerCase();
  if (!text || text === 'false' || text === '0' || text === 'off') return false;
  if (text === 'true' || text === '1' || text === 'on') {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: text !== 'no-verify' };
}

function parseInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function clean(value) {
  return String(value || '').trim();
}
