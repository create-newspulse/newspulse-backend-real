const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computePublicEnabled,
  clampScrollDurationSeconds,
  applySettingsPatch,
} = require('../services/broadcastCenter.service');

test('Broadcast config: computePublicEnabled does not flip off when items are empty', () => {
  assert.equal(computePublicEnabled(true, 'auto'), true);
  assert.equal(computePublicEnabled(true, 'force_on'), true);
  assert.equal(computePublicEnabled(true, 'force_off'), false);
  assert.equal(computePublicEnabled(false, 'auto'), false);
});

test('Broadcast config: clampScrollDurationSeconds clamps to 12..30', () => {
  assert.equal(clampScrollDurationSeconds(5), 12);
  assert.equal(clampScrollDurationSeconds(12), 12);
  assert.equal(clampScrollDurationSeconds(18), 18);
  assert.equal(clampScrollDurationSeconds(30), 30);
  assert.equal(clampScrollDurationSeconds(45), 30);
  assert.equal(clampScrollDurationSeconds('22'), 22);
  assert.equal(clampScrollDurationSeconds('not-a-number'), null);
});

test('Broadcast config: duration-only patch preserves enabled + mode (merge)', () => {
  const doc = {
    breaking: { enabled: true, mode: 'force_on', tickerSpeedSeconds: 12, speedSec: 12 },
    live: { enabled: false, mode: 'force_off', tickerSpeedSeconds: 12, speedSec: 12 },
  };

  const res = applySettingsPatch(doc, { breaking: { durationSec: 18 } });
  assert.equal(res.ok, true);

  assert.equal(doc.breaking.enabled, true);
  assert.equal(doc.breaking.mode, 'force_on');
  assert.equal(doc.breaking.tickerSpeedSeconds, 18);
  assert.equal(doc.breaking.speedSec, 18);

  // untouched channel
  assert.equal(doc.live.enabled, false);
  assert.equal(doc.live.mode, 'force_off');
});
