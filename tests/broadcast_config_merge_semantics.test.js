const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computePublicEnabled,
  clampScrollDurationSeconds,
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
