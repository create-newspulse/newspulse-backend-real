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
const BroadcastVersion = require('../models/BroadcastVersion');
const googleTranslate = require('../services/googleTranslate.service');

test('Public Broadcast: lang-aware translation + cache does not leak across langs', async () => {
  const prevReady = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  // Seed Gujarati-only ticker items.
  const now = new Date();
  const breakingDocs = [
    { _id: 'b1', type: 'breaking', isLive: true, text_i18n: { gu: 'ગુજરાતી બ્રેકિંગ 1' }, createdAt: now, expiresAt: null },
    { _id: 'b2', type: 'breaking', isLive: true, text: 'ગુજરાતી બ્રેકિંગ 2', createdAt: now, expiresAt: null },
  ];
  const liveDocs = [
    { _id: 'l1', type: 'live', isLive: true, text_i18n: { gu: 'ગુજરાતી લાઇવ 1' }, createdAt: now, expiresAt: null },
  ];

  // Minimal settings doc (avoids backfill/saves).
  BroadcastSettings.findOne = async () => ({
    breaking: { enabled: true, mode: 'auto', tickerSpeedSeconds: 18, speedSec: 18 },
    live: { enabled: true, mode: 'auto', tickerSpeedSeconds: 18, speedSec: 18 },
    save: async () => {},
  });

  // Version is stable across requests in this test so we exercise cache behavior.
  BroadcastVersion.findOne = () => ({
    lean: async () => ({ key: 'global', version: 1 }),
  });

  // Query-chain stub used by listItemsLast24hByChannel().
  BroadcastItem.find = (filter) => {
    const type = filter && filter.type;
    const docs = type === 'breaking' ? breakingDocs : (type === 'live' ? liveDocs : []);
    return {
      sort() { return this; },
      limit() { return this; },
      lean: async () => docs,
    };
  };

  // Deterministic translation without hitting Google.
  googleTranslate.translateMany = async (texts, targetLang) => {
    const lang = String(targetLang || '').toLowerCase();
    return { ok: true, items: (texts || []).map((t) => `${lang}:${String(t)}`) };
  };

  const resGu = await request(app)
    .get('/api/public/broadcast?lang=gu')
    .expect('Content-Type', /json/)
    .expect(200);

  assert.deepEqual(resGu.body.breaking.items, ['ગુજરાતી બ્રેકિંગ 1', 'ગુજરાતી બ્રેકિંગ 2']);
  assert.deepEqual(resGu.body.live.items, ['ગુજરાતી લાઇવ 1']);

  // If cache key were missing lang, this could incorrectly return Gujarati.
  const resEn = await request(app)
    .get('/api/public/broadcast?lang=en')
    .expect(200);

  assert.deepEqual(resEn.body.breaking.items, ['en:ગુજરાતી બ્રેકિંગ 1', 'en:ગુજરાતી બ્રેકિંગ 2']);
  assert.deepEqual(resEn.body.live.items, ['en:ગુજરાતી લાઇવ 1']);

  const resHi = await request(app)
    .get('/api/public/broadcast?lang=hi')
    .expect(200);

  assert.deepEqual(resHi.body.breaking.items, ['hi:ગુજરાતી બ્રેકિંગ 1', 'hi:ગુજરાતી બ્રેકિંગ 2']);
  assert.deepEqual(resHi.body.live.items, ['hi:ગુજરાતી લાઇવ 1']);

  assert.notDeepEqual(resEn.body.breaking.items, resGu.body.breaking.items);
  assert.notDeepEqual(resHi.body.breaking.items, resGu.body.breaking.items);

  mongoose.connection.readyState = prevReady;
});
