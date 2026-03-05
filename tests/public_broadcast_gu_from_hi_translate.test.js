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

test('Public Broadcast: /gu translates hi-authored items to Gujarati (no Hindi fallback)', async () => {
  const prevReady = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  const now = new Date();
  const breakingDocs = [
    {
      _id: 'b_hi_1',
      type: 'breaking',
      isLive: true,
      text: 'हिंदी ब्रेकिंग',
      lang: 'hi',
      i18n: { hi: { text: 'हिंदी ब्रेकिंग' } },
      createdAt: now,
      expiresAt: null,
    },
  ];

  BroadcastSettings.findOne = async () => ({
    breaking: { enabled: true, mode: 'auto', tickerSpeedSeconds: 18, speedSec: 18 },
    live: { enabled: true, mode: 'auto', tickerSpeedSeconds: 18, speedSec: 18 },
    save: async () => {},
  });

  BroadcastVersion.findOne = () => ({
    lean: async () => ({ key: 'global', version: 1 }),
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

  googleTranslate.translateMany = async (texts, targetLang, options = {}) => {
    assert.equal(String(targetLang), 'gu');
    // Ensure we don't accidentally treat Gujarati as the source.
    assert.equal(String(options.sourceLang), 'hi');
    return { ok: true, items: (texts || []).map((t) => `gu:${String(t)}`) };
  };

  const res = await request(app)
    .get('/api/public/broadcast?lang=gu')
    .expect(200);

  assert.deepEqual(res.body.breaking.items, ['gu:हिंदी ब्रेकिंग']);

  mongoose.connection.readyState = prevReady;
});
