const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computePublicEnabled,
  clampScrollDurationSeconds,
  applySettingsPatch,
  adminSettingsResponse,
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

function configuredDoc() {
  return {
    breaking: { enabled: false, mode: 'force_on', tickerSpeedSeconds: 20, speedSec: 20, maxItems: 7 },
    live: { enabled: true, mode: 'auto', tickerSpeedSeconds: 24, speedSec: 24, maxItems: 17 },
    pauseOnHover: false,
  };
}

for (const channel of ['breaking', 'live']) {
  test(`Broadcast canonical ${channel}: field-only patches preserve all unrelated configuration`, () => {
    for (const patch of [
      { tickerSpeedSeconds: 27 },
      { enabled: channel === 'breaking' },
      { mode: 'force_off' },
      { maxItems: 3 },
    ]) {
      const doc = configuredDoc();
      const expected = configuredDoc();
      Object.assign(expected[channel], patch);
      if (patch.tickerSpeedSeconds) expected[channel].speedSec = patch.tickerSpeedSeconds;
      assert.equal(applySettingsPatch(doc, { [channel]: patch }).ok, true);
      assert.deepEqual(doc, expected);
    }
  });

  test(`Broadcast canonical ${channel}: aliases normalize and canonical duration wins`, () => {
    const aliases = ['speedSec', 'speedSeconds', 'durationSec', 'durationSeconds', 'scrollDurationSec', 'scrollDurationSeconds', 'speed'];
    for (const alias of aliases) {
      const doc = configuredDoc();
      assert.equal(applySettingsPatch(doc, { [channel]: { [alias]: '22' } }).ok, true);
      assert.equal(doc[channel].tickerSpeedSeconds, 22);
      assert.equal(doc[channel].speedSec, 22);
      for (const conflict of [12, 30, 'invalid']) {
        assert.equal(applySettingsPatch(doc, { [channel]: { tickerSpeedSeconds: 25, [alias]: conflict } }).ok, true);
        assert.equal(doc[channel].tickerSpeedSeconds, 25);
      }
    }
    const invalid = applySettingsPatch(configuredDoc(), {
      [channel]: { tickerSpeedSeconds: 'invalid', speedSec: 20 },
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.status, 400);
  });
}

test('Broadcast canonical pause-on-hover changes neither channel; response mirrors canonical duration', () => {
  const doc = configuredDoc();
  const expected = { ...configuredDoc(), pauseOnHover: true };
  assert.equal(applySettingsPatch(doc, { pauseOnHover: true }).ok, true);
  assert.deepEqual(doc, expected);
  doc.breaking.speedSec = 30;
  const response = adminSettingsResponse(doc);
  for (const alias of ['durationSec', 'durationSeconds', 'tickerSpeedSeconds', 'speedSec']) {
    assert.equal(response.breaking[alias], 20);
    assert.equal(response.live[alias], 24);
  }
  assert.equal(response.breaking.enabled, false);
  assert.equal(response.breaking.mode, 'force_on');
  assert.equal(response.breaking.maxItems, 7);
  assert.equal(response.live.maxItems, 17);
  assert.equal(response.pauseOnHover, true);
});
