const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDateMaybe } = require('../lib/ads');

test('parseDateMaybe parses legacy "DD-MM-YYYY HH:mm" as local Date', () => {
  const out = parseDateMaybe('15-03-2026 22:29');
  assert.equal(out.ok, true);
  assert.ok(out.date instanceof Date);
  assert.equal(out.date.getFullYear(), 2026);
  assert.equal(out.date.getMonth(), 2); // March (0-based)
  assert.equal(out.date.getDate(), 15);
  assert.equal(out.date.getHours(), 22);
  assert.equal(out.date.getMinutes(), 29);
});

test('parseDateMaybe rejects unparseable strings', () => {
  const out = parseDateMaybe('not-a-date');
  assert.equal(out.ok, false);
  assert.equal(out.date, null);
});

test('parseDateMaybe parses ISO strings safely', () => {
  const out = parseDateMaybe('2026-03-16T10:14:00.000Z');
  assert.equal(out.ok, true);
  assert.ok(out.date instanceof Date);
  assert.equal(out.date.toISOString(), '2026-03-16T10:14:00.000Z');
});

test('parseDateMaybe rejects non-ISO slash dates (unsafe)', () => {
  const out = parseDateMaybe('03/16/2026');
  assert.equal(out.ok, false);
  assert.equal(out.date, null);
});
