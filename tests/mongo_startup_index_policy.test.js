const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const harness = path.join(__dirname, 'helpers', 'mongoStartupHarness.js');
const systemKeys = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
]);

function runStartup(fixture) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemKeys.has(key.toUpperCase())));
  const child = spawnSync(process.execPath, [harness, JSON.stringify(fixture)], {
    cwd: path.join(__dirname, '..'),
    env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = child.stdout.split(/\r?\n/).find(line => line.startsWith('STARTUP_POLICY_RESULT '));
  assert.ok(report, `Startup did not finish: ${child.stderr}`);
  const result = JSON.parse(report.slice('STARTUP_POLICY_RESULT '.length));
  assert.deepEqual(result.violations, [], 'Isolation violations cannot be swallowed by startup catches');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.maintenanceImports, []);
  assert.ok(result.compiled.length > 20, 'Exercise real route imports and model compilation');
  for (const name of ['News', 'Article', 'User', 'Ad', 'BroadcastItem', 'TranslationJob']) {
    assert.ok(result.models.includes(name), `${name} remains available`);
  }
  for (const [name, mounted] of Object.entries(result.mountedRoutes)) {
    assert.equal(mounted, true, `${name} remains mounted`);
  }
  for (const response of Object.values(result.health)) assert.equal(response.status, 200);
  assert.equal(result.health['/health'].body.status, 'ok');
  assert.equal(result.health['/api/health'].body.ok, true);
  return result;
}

function assertConnectedStartup(result, connections = 1) {
  assert.equal(result.connections, connections);
  assert.equal(result.listens, 1);
  assert.equal(result.initializedModels, result.models.length);
  assert.equal(result.health['/api/system/health'].body.data.mongo.connected, true);
  assert.equal(result.services.startCanonicalLatestPrewarm, 1);
  assert.equal(result.services.createAdsTransport, 1);
  for (const method of [
    'seedFounderFromEnvIfNeeded', 'startBroadcastCleanupJob',
    'startPublishTranslationWorker', 'startNewsPulseEngineMonitoring',
  ]) {
    assert.equal(result.services[method], connections, `${method} remains active`);
  }
  assert.equal(result.services.publishDueScheduledArticles, 1);
  assert.equal(result.services.refreshDuePublicArticleVisibility, 1);
  assert.deepEqual(result.schedulers, [60000]);
  assert.equal(result.audits.filter(name => name === 'news_pulse_incidents').length, connections);
  assert.equal(result.audits.filter(name => name === 'news_pulse_alerts').length, connections);
}

function assertIndexPreserving(result) {
  for (const model of result.compiled) {
    assert.equal(model.autoIndex, false, `${model.model}: Boolean false before compilation`);
    assert.equal(model.autoCreate, false, `${model.model}: Boolean false before compilation`);
  }
  assert.deepEqual(result.mongooseCalls, {});
  assert.deepEqual(result.commands, {});
  assert.deepEqual(result.syncModels, []);
  assert.equal(result.newsIndexCount, 64);
  assert.equal(result.newsIndexesUnchanged, true);
}

const productionFixtures = [
  { name: 'production', env: { NODE_ENV: 'production' } },
  { name: 'normalized production', env: { NODE_ENV: ' PrOdUcTiOn ' } },
  { name: 'Render with development NODE_ENV', env: { NODE_ENV: 'development', RENDER: 'true' } },
  { name: 'Render service ID without NODE_ENV', env: { NODE_ENV: '', RENDER_SERVICE_ID: 'synthetic-service' } },
  { name: 'Render URL indicator', env: { RENDER_EXTERNAL_URL: 'https://startup-fixture.invalid' } },
  { name: 'production resolved after synthetic dotenv', dotenv: { NODE_ENV: 'production' } },
  { name: 'production reconnect', env: { NODE_ENV: 'production' }, reconnect: true },
  { name: 'production TTL mismatch', env: { NODE_ENV: 'production' }, ttlMismatch: true },
];
for (const fixture of productionFixtures) {
  test(`${fixture.name}: startup preserves indexes and essential initialization`, () => {
    const result = runStartup(fixture);
    assertConnectedStartup(result, fixture.reconnect ? 2 : 1);
    assertIndexPreserving(result);
    const mismatchWarning = result.warnings.some(message => message.includes('TTL index audit found mismatches'));
    assert.equal(mismatchWarning, !!fixture.ttlMismatch, 'TTL diagnostics remain read-only and visible');
  });
}

test('development retains automatic index creation and all five startup synchronizations', () => {
  const result = runStartup({ env: { NODE_ENV: 'development' } });
  assertConnectedStartup(result);
  for (const model of result.compiled) {
    assert.equal(model.autoIndex, true);
    assert.equal(model.autoCreate, true);
  }
  assert.deepEqual(result.syncModels, ['BroadcastItem', 'GlossaryTerm', 'TranslationMemory', 'Ad', 'TranslationJob']);
  assert.equal(result.mongooseCalls.syncIndexes, 5);
  assert.ok(result.commands.createIndexes > 0, 'Positive control: actual Mongoose initialization reaches the driver stand-in');
  assert.ok(result.commands.create > 0);
});

for (const fixture of [
  { name: 'test mode', env: { NODE_ENV: 'test' } },
  { name: 'production import mode', env: { NODE_ENV: 'production' }, imported: true },
]) {
  test(`${fixture.name}: existing connection/startup skips remain intact`, () => {
    const result = runStartup(fixture);
    assert.equal(result.connections, 0);
    assert.equal(result.listens, fixture.imported ? 0 : 1);
    assert.deepEqual(result.schedulers, []);
    assert.deepEqual(result.services, {
      startCanonicalLatestPrewarm: 1,
      ...(!fixture.imported ? { createAdsTransport: 1 } : {}),
    });
    assert.deepEqual(result.audits, []);
    assert.deepEqual(result.commands, {});
    assert.deepEqual(result.mongooseCalls, {});
    if (fixture.imported) assertIndexPreserving(result);
  });
}
