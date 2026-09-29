const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pattern = /^(pulse_dialogue_.*|contributor_slug_rollout|author_byline|public_category_aliases|public_news_.*|spotlight_priority_model|admin_articles_spotlight_update|public_sponsored_features_routes|admin_sponsored_features_routes|ad_settings|public_ads_slot|public_ads_new_slots_toggle_behavior|public_ads_footer_toggle_missing|admin_ads_home_left_slot|admin_ads_home_left_300x600_slot|admin_analytics_readership_aggregation)\.test\.js$/;
const requested = process.argv.slice(2);
const files = fs.readdirSync(path.join(root, 'tests')).filter(name => pattern.test(name) && (!requested.length || requested.includes(name)));
if (!files.length || requested.some(name => !files.includes(name))) {
  console.error('Select existing test filenames within the Pulse Dialogue regression slice.');
  process.exit(1);
}

function isolate() {
  process.env.NODE_ENV = 'test';
  process.env.NEWSPULSE_ALLOW_REDIS_IN_TESTS = '0';
  require('dotenv').config = () => ({ parsed: {} });
  const mongoose = require('mongoose');
  mongoose.connect = () => { throw new Error('Test database connection forbidden'); };
  mongoose.createConnection = mongoose.connect;
  const net = require('node:net');
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = options && typeof options === 'object' ? options.host : (typeof args[1] === 'string' ? args[1] : null);
    if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('External test connection forbidden');
    return connect.apply(this, args);
  };
  console.log = () => {};
  console.warn = () => {};
  console.info = () => {};
}

let failures = 0;
let tests = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['-e', `(${isolate.toString()})();require(${JSON.stringify(`./tests/${file}`)});`],
    { cwd: root, encoding: 'utf8', maxBuffer: 4000000 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const count = output.match(/tests (\d+)/);
  tests += count ? Number(count[1]) : 0;
  console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} ${file}${count ? ` (${count[1]} tests)` : ''}`);
  if (result.status !== 0) {
    failures += 1;
    console.log(output.slice(-14000));
    if (result.error) console.error(result.error.message);
  }
}
console.log(JSON.stringify({ files: files.length, tests, failedFiles: failures }));
process.exitCode = failures ? 1 : 0;