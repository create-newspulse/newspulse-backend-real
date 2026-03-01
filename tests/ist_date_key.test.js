const test = require('node:test');
const assert = require('node:assert/strict');

const { getIstDateKey, getIstDayRangeUtc, formatIstTimeText } = require('../src/utils/istDate');

test('getIstDateKey uses fixed IST offset (+05:30)', () => {
  // 2026-01-01 00:10 IST == 2025-12-31 18:40 UTC
  const utc = new Date(Date.UTC(2025, 11, 31, 18, 40, 0));
  assert.equal(getIstDateKey(utc), '2026-01-01');

  // 2026-01-01 23:59 IST == 2026-01-01 18:29 UTC
  const utc2 = new Date(Date.UTC(2026, 0, 1, 18, 29, 0));
  assert.equal(getIstDateKey(utc2), '2026-01-01');
});

test('getIstDayRangeUtc returns start/end UTC for an IST dateKey', () => {
  const r = getIstDayRangeUtc('2026-01-01');
  assert.ok(r);
  // IST midnight 2026-01-01 == 2025-12-31 18:30 UTC
  assert.equal(r.startUtc.toISOString(), '2025-12-31T18:30:00.000Z');
  assert.equal(r.endUtc.toISOString(), '2026-01-01T18:30:00.000Z');
});

test('formatIstTimeText renders AM/PM time from UTC input', () => {
  // 2026-01-01 10:05 IST == 2026-01-01 04:35 UTC
  const utc = new Date(Date.UTC(2026, 0, 1, 4, 35, 0));
  assert.equal(formatIstTimeText(utc), '10:05 AM');
});
