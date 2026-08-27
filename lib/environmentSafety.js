function normalizeEnvName(value) {
  return String(value || '').trim().toLowerCase();
}

function isRenderLike(env = process.env) {
  return !!(env.RENDER || env.RENDER_SERVICE_ID || env.RENDER_EXTERNAL_URL);
}

function isProductionLike(env = process.env) {
  return normalizeEnvName(env.NODE_ENV) === 'production' || isRenderLike(env);
}

function isTestLike(env = process.env) {
  return normalizeEnvName(env.NODE_ENV) === 'test';
}

function isLocalDevelopmentLike(env = process.env) {
  if (isTestLike(env)) return false;
  if (normalizeEnvName(env.NODE_ENV) === 'production' || env.RENDER || env.RENDER_SERVICE_ID) return false;
  const nodeEnv = normalizeEnvName(env.NODE_ENV || 'development');
  const appEnv = normalizeEnvName(env.APP_ENV);
  return ['development', 'dev', 'local'].includes(nodeEnv) || ['development', 'dev', 'local'].includes(appEnv);
}

function redactMongoUri(uri) {
  const value = String(uri || '');
  if (!value) return '';
  return value.replace(/(mongodb(?:\+srv)?:\/\/)([^@/]+)@/i, '$1***:***@');
}

function mongoDbNameFromUri(uri) {
  const raw = String(uri || '').trim();
  if (!raw) return null;
  const afterSlash = raw.split('/').slice(3).join('/');
  if (!afterSlash) return null;
  const dbPart = afterSlash.split('?')[0];
  const dbName = String(dbPart || '').trim();
  if (!dbName) return null;
  return dbName.split('/')[0] || null;
}

function getConfiguredMongoUri(env = process.env) {
  return String(env.MONGODB_URI || env.MONGO_URI || '').trim();
}

function getConfiguredMongoDbName(env = process.env) {
  return String(env.MONGODB_DBNAME || '').trim() || mongoDbNameFromUri(getConfiguredMongoUri(env));
}

function isDevelopmentDatabaseName(dbName) {
  return /(^|[-_.])(dev|development|local|test|testing|sandbox)([-_.]|$)/i.test(String(dbName || '').trim());
}

function isProductionDatabaseName(dbName) {
  const normalized = normalizeEnvName(dbName);
  if (!normalized) return false;
  if (/(^|[-_.])(prod|production|live)([-_.]|$)/i.test(normalized)) return true;
  return normalized === 'newspulse' || normalized === 'news-pulse' || normalized === 'news_pulse';
}

function hasLocalDevelopmentBlockedTestDatabase(dbName) {
  const normalized = normalizeEnvName(dbName);
  return normalized === 'test';
}

function validateLocalDatabaseIsolation(env = process.env) {
  if (!isLocalDevelopmentLike(env)) {
    return { ok: true, skipped: true, reason: 'not-local-development' };
  }

  const uri = getConfiguredMongoUri(env);
  const dbName = getConfiguredMongoDbName(env);
  const failures = [];

  if (!uri) failures.push('Local database configuration missing. Refusing to start development server.');
  if (uri && !dbName) failures.push('Local database name missing from MongoDB configuration. Refusing to start development server.');
  if (dbName && hasLocalDevelopmentBlockedTestDatabase(dbName)) {
    failures.push('[ENV SAFETY] Local development cannot use the live News Pulse database `test`. Use `newspulse_dev`. Startup aborted.');
  }
  if (dbName && isProductionDatabaseName(dbName)) failures.push('[ENV SAFETY] Local development is configured with a production-looking database name. Startup aborted.');
  if (dbName && !isDevelopmentDatabaseName(dbName)) failures.push('[ENV SAFETY] Local development database name must include dev, development, local, test, testing, or sandbox. Startup aborted.');

  const rawValues = [uri, env.BACKEND_BASE_URL, env.RENDER_EXTERNAL_URL]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (rawValues.some((value) => /onrender\.com/i.test(value))) {
    failures.push('[ENV SAFETY] Local development is configured with a production Render backend dependency. Startup aborted.');
  }

  const reporterOtpEmailMode = String(env.REPORTER_OTP_EMAIL_MODE || env.REPORTER_EMAIL_MODE || env.EMAIL_MODE || '').trim().toLowerCase();
  if (reporterOtpEmailMode && reporterOtpEmailMode !== 'stub') {
    failures.push('[ENV SAFETY] Local Reporter Portal OTP must use development/test email delivery. Set EMAIL_MODE=stub or remove the production email mode.');
  }

  return {
    ok: failures.length === 0,
    skipped: false,
    failures,
    databaseName: dbName || null,
    hasMongoUri: !!uri,
    redactedMongoUri: redactMongoUri(uri),
  };
}

function requireLocalDatabaseIsolation(env = process.env) {
  const result = validateLocalDatabaseIsolation(env);
  if (!result.ok) {
    const error = new Error(result.failures.join('\n'));
    error.code = 'ENV_SAFETY_LOCAL_DB_REFUSED';
    error.details = result;
    throw error;
  }
  return result;
}

function parseCorsOrigins(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const parts = raw.split(',').map((entry) => String(entry || '').trim()).filter(Boolean);
  const normalized = [];
  for (const part of parts) {
    if (part.includes('://')) {
      normalized.push(part);
    } else {
      normalized.push(`https://${part}`);
      normalized.push(`http://${part}`);
    }
  }
  return normalized;
}

function isLocalOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(origin || '').trim());
}

function buildAllowedCorsOrigins(env = process.env) {
  const localOrigins = [
    'http://localhost:3000',
    'http://localhost:4173',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:4173',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
  ];
  const productionOrigins = [
    'https://www.newspulse.co.in',
    'https://newspulse.co.in',
    'https://admin.newspulse.co.in',
    'https://newspulse-admin-panel-real.vercel.app',
    'https://newspulse-frontend-main.vercel.app',
  ];
  const fromEnv = parseCorsOrigins(env.ALLOWED_ORIGINS || env.CORS_ORIGIN);
  const production = isProductionLike(env);
  const defaults = production ? productionOrigins : [...localOrigins, ...productionOrigins];
  const envOrigins = production ? fromEnv.filter((origin) => !isLocalOrigin(origin)) : fromEnv;
  return Array.from(new Set([...defaults, ...envOrigins].map((origin) => String(origin))));
}

module.exports = {
  buildAllowedCorsOrigins,
  getConfiguredMongoDbName,
  getConfiguredMongoUri,
  isDevelopmentDatabaseName,
  isLocalDevelopmentLike,
  isLocalOrigin,
  isProductionDatabaseName,
  isProductionLike,
  isRenderLike,
  isTestLike,
  mongoDbNameFromUri,
  parseCorsOrigins,
  redactMongoUri,
  requireLocalDatabaseIsolation,
  validateLocalDatabaseIsolation,
};