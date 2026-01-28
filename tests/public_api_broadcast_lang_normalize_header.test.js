const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';
process.env.GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || 'test-key';

const app = require('../server');

const BroadcastItem = require('../models/BroadcastItem');
const BroadcastSettings = require('../models/BroadcastSettings');
const googleTranslate = require('../services/googleTranslate.service');

test('Public API Broadcast: normalizes lang like en-US and accepts x-lang header', async () => {
  const prevReady = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  const now = new Date();
  const breakingDocs = [
    { _id: 'b1', type: 'breaking', isLive: true, text_i18n: { gu: 'ગુજરાતી 1' }, createdAt: now, expiresAt: null },
  ];

  BroadcastSettings.findOne = async () => ({
    breaking: { enabled: true, mode: 'auto', tickerSpeedSeconds: 18, speedSec: 18 },
    live: { enabled: true, mode: 'auto', tickerSpeedSeconds: 18, speedSec: 18 },
    save: async () => {},
  });

  BroadcastItem.find = (filter) => {
    const type = filter && filter.type;
    const docs = type === 'breaking' ? breakingDocs : [];
    return {
      sort() { return this; },
      limit() { return this; },
      lean: async () => docs,
    };
  };

  googleTranslate.translateMany = async (texts, targetLang) => {
    const lang = String(targetLang || '').toLowerCase();
    return { ok: true, items: (texts || []).map((t) => `${lang}:${String(t)}`) };
  };

  // Query param en-US -> en
  const res1 = await request(app)
    .get('/public-api/broadcast?lang=en-US&nocache=1')
    .expect(200);

  assert.equal(res1.body.ok, true);
  assert.deepEqual(res1.body.data.breaking.items, ['en:ગુજરાતી 1']);

  // Header x-lang en-US -> en
  const res2 = await request(app)
    .get('/public-api/broadcast?nocache=1')
    .set('x-lang', 'en-US')
    .expect(200);

  assert.equal(res2.body.ok, true);
  assert.deepEqual(res2.body.data.breaking.items, ['en:ગુજરાતી 1']);

  mongoose.connection.readyState = prevReady;
});
