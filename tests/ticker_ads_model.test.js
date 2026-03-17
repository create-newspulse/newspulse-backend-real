const test = require('node:test');
const assert = require('node:assert/strict');

const TickerAd = require('../models/TickerAd');

test('TickerAd model sanitizes message, clamps frequency, and validates schedule', async () => {
  const doc = new TickerAd({
    message: '  <b>Flash</b>   sale <script>alert(1)</script>  ',
    url: 'https://example.com/deal',
    lang: 'en',
    channel: 'live',
    startAt: '2026-03-18T00:00:00.000Z',
    endAt: '2026-03-19T00:00:00.000Z',
    dayParts: ['morning', 'morning', 'evening'],
    frequency: 99,
  });

  await doc.validate();

  assert.equal(doc.message, 'Flash sale');
  assert.deepEqual(doc.dayParts, ['morning', 'evening']);
  assert.equal(doc.frequency, 10);
});

test('TickerAd model rejects invalid url and inverted schedule', async () => {
  const doc = new TickerAd({
    message: 'Valid text',
    url: 'ftp://example.com/bad',
    lang: 'en',
    channel: 'breaking',
    startAt: '2026-03-19T00:00:00.000Z',
    endAt: '2026-03-18T00:00:00.000Z',
  });

  await assert.rejects(() => doc.validate(), (error) => {
    assert.equal(error.name, 'ValidationError');
    assert.ok(error.errors.url);
    assert.ok(error.errors.endAt);
    return true;
  });
});