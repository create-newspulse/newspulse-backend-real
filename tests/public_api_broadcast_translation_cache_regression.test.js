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

test('Public API Broadcast: translation fallback is not cached (prevents stuck Gujarati for en)', async () => {
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

  // Fail once, then succeed.
  let calls = 0;
  googleTranslate.translateMany = async (texts, targetLang) => {
    calls++;
    if (calls === 1) return { ok: false, error: 'TEMP_FAIL' };
    const lang = String(targetLang || '').toLowerCase();
    return { ok: true, items: (texts || []).map((t) => `${lang}:${String(t)}`) };
  };

  const res1 = await request(app)
    .get('/public-api/broadcast?lang=en')
    .expect(200);

  assert.deepEqual(res1.body.breaking.items, ['ગુજરાતી 1']);

  // If fallback were cached, this second response would stay Gujarati.
  const res2 = await request(app)
    .get('/public-api/broadcast?lang=en')
    .expect(200);

  assert.deepEqual(res2.body.breaking.items, ['en:ગુજરાતી 1']);

  mongoose.connection.readyState = prevReady;
});
