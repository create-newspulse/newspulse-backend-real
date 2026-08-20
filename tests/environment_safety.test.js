const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAllowedCorsOrigins,
  validateLocalDatabaseIsolation,
} = require('../lib/environmentSafety');

function makeEnv(overrides = {}) {
  return {
    NODE_ENV: 'development',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/newspulse_dev',
    ...overrides,
  };
}

test('development refuses to start without a local database URI', () => {
  const result = validateLocalDatabaseIsolation(makeEnv({ MONGODB_URI: '' }));

  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /Local database configuration missing/);
});

test('development accepts explicitly local or test database names', () => {
  const localResult = validateLocalDatabaseIsolation(makeEnv({ MONGODB_URI: 'mongodb://127.0.0.1:27017/newspulse_local' }));
  const testResult = validateLocalDatabaseIsolation(makeEnv({ MONGODB_URI: 'mongodb+srv://user:pass@example.mongodb.net/newspulse_test?retryWrites=true' }));

  assert.equal(localResult.ok, true);
  assert.equal(localResult.databaseName, 'newspulse_local');
  assert.equal(testResult.ok, true);
  assert.equal(testResult.databaseName, 'newspulse_test');
});

test('development refuses production-looking database names and Render dependencies', () => {
  const prodDb = validateLocalDatabaseIsolation(makeEnv({ MONGODB_URI: 'mongodb+srv://user:pass@example.mongodb.net/newspulse?retryWrites=true' }));
  const renderBackend = validateLocalDatabaseIsolation(makeEnv({ BACKEND_BASE_URL: 'https://newspulse-backend.onrender.com' }));

  assert.equal(prodDb.ok, false);
  assert.match(prodDb.failures.join('\n'), /production-looking database name|database name must include/);
  assert.equal(renderBackend.ok, false);
  assert.match(renderBackend.failures.join('\n'), /production Render backend dependency/);
});

test('development refuses explicit non-stub reporter OTP email mode', () => {
  const result = validateLocalDatabaseIsolation(makeEnv({ REPORTER_OTP_EMAIL_MODE: 'smtp' }));

  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /Reporter Portal OTP must use development\/test email delivery/);
});

test('CORS allows localhost only outside production-like environments', () => {
  const developmentOrigins = buildAllowedCorsOrigins(makeEnv({ ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:5173' }));
  const productionOrigins = buildAllowedCorsOrigins({
    NODE_ENV: 'production',
    ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:5173,https://admin.newspulse.co.in',
  });

  assert.ok(developmentOrigins.includes('http://localhost:3000'));
  assert.ok(developmentOrigins.includes('http://localhost:5173'));
  assert.ok(productionOrigins.includes('https://www.newspulse.co.in'));
  assert.ok(productionOrigins.includes('https://admin.newspulse.co.in'));
  assert.equal(productionOrigins.includes('http://localhost:3000'), false);
  assert.equal(productionOrigins.includes('http://localhost:5173'), false);
});