const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'pass';

const app = require('../server');

const BroadcastItem = require('../models/BroadcastItem');
const BroadcastSettings = require('../models/BroadcastSettings');

test('Broadcast tickers: create Gujarati then fetch en/hi/gu', async () => {
  const prevReady = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  const token = `np.${Buffer.from(`${process.env.ADMIN_EMAIL}:${Date.now()}`).toString('base64')}`;

  // Minimal settings doc
  BroadcastSettings.findOne = async () => ({
    breaking: { enabled: true, mode: 'auto', tickerSpeedSeconds: 18, speedSec: 18 },
    live: { enabled: true, mode: 'auto', tickerSpeedSeconds: 18, speedSec: 18 },
    save: async () => {},
  });

  // Stub admin login (server already has route), and broadcast item DB ops.
  const createdDocs = [];
  BroadcastItem.create = async (payload) => {
    const doc = {
      _id: 'b1',
      ...payload,
      translations: payload.translations || {},
      text_i18n: payload.text_i18n || {},
      textByLang: payload.textByLang || {},
      save: async () => {},
    };
    createdDocs.push(doc);
    return doc;
  };
  BroadcastItem.find = (filter) => {
    const type = filter && filter.type;
    const docs = type === 'breaking' ? createdDocs : [];
    return {
      sort() { return this; },
      limit() { return this; },
      lean: async () => docs,
    };
  };

  // Force deterministic translations via guarded translator.
  const guarded = require('../services/translate/guardedTranslate');
  guarded.translateWithGuardrails = async (text, sourceLang, targetLang) => {
    return { ok: true, text: `${targetLang}:${text}`, score: 1, needsReview: false };
  };

  await request(app)
    .post('/api/admin/broadcast/items')
    .set('Authorization', `Bearer ${token}`)
    .send({ type: 'breaking', text: 'ગુજરાતી ટિકર', lang: 'gu' })
    .expect(201);

  const gu = await request(app).get('/public-api/broadcast?lang=gu&nocache=1').expect(200);
  assert.equal(gu.body.ok, true);
  assert.deepEqual(gu.body.data.breaking.items, ['ગુજરાતી ટિકર']);

  const hi = await request(app).get('/public-api/broadcast?lang=hi&nocache=1').expect(200);
  assert.equal(hi.body.ok, true);
  assert.deepEqual(hi.body.data.breaking.items, ['hi:ગુજરાતી ટિકર']);

  const en = await request(app).get('/public-api/broadcast?lang=en&nocache=1').expect(200);
  assert.equal(en.body.ok, true);
  assert.deepEqual(en.body.data.breaking.items, ['en:ગુજરાતી ટિકર']);

  mongoose.connection.readyState = prevReady;
});
