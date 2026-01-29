const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');

const BroadcastItem = require('../models/BroadcastItem');
const guardedTranslate = require('../services/translate/guardedTranslate');

function opaqueAdminToken(email) {
  return `np.${Buffer.from(`${email}:${Date.now()}`).toString('base64')}`;
}

test('Admin broadcast items: POST and PATCH persist i18n translations (en/hi/gu)', async () => {
  const prevReady = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  const token = opaqueAdminToken('admin@example.com');

  const translations = {
    // For create
    create: {
      en: 'en:ગુજરાતી ટિકર',
      hi: 'hi:ગુજરાતી ટિકર',
    },
    // For update
    update: {
      en: 'en:નવી ટિકર',
      hi: 'hi:નવી ટિકર',
    },
  };

  const origTranslate = guardedTranslate.translateWithGuardrails;
  guardedTranslate.translateWithGuardrails = async (text, sourceLang, targetLang) => {
    const t = String(text || '').trim();
    if (!t) return { ok: false, text: null };
    if (targetLang === 'en') return { ok: true, text: t === 'નવી ટિકર' ? translations.update.en : translations.create.en };
    if (targetLang === 'hi') return { ok: true, text: t === 'નવી ટિકર' ? translations.update.hi : translations.create.hi };
    if (targetLang === 'gu') return { ok: true, text: t };
    return { ok: false, text: null };
  };

  // Stub DB ops
  const createdDocs = new Map();
  const realCreate = BroadcastItem.create;
  const realFindById = BroadcastItem.findById;

  BroadcastItem.create = async (payload) => {
    const id = new mongoose.Types.ObjectId().toString();
    const doc = {
      _id: id,
      ...payload,
      set(k, v) { this[k] = v; },
      save: async () => doc,
    };
    createdDocs.set(id, doc);
    return doc;
  };

  BroadcastItem.findById = async (id) => createdDocs.get(String(id)) || null;

  const createRes = await request(app)
    .post('/api/admin/broadcast/items')
    .set('Authorization', `Bearer ${token}`)
    .send({ type: 'breaking', text: 'ગુજરાતી ટિકર', lang: 'gu', autoTranslate: true })
    .expect(201);

  assert.equal(createRes.body.ok, true);

  const created = Array.from(createdDocs.values())[0];
  assert.ok(created, 'expected created BroadcastItem doc');
  assert.equal(created.sourceLang, 'gu');
  assert.equal(created.text_i18n.gu, 'ગુજરાતી ટિકર');
  assert.equal(created.text_i18n.en, translations.create.en);
  assert.equal(created.text_i18n.hi, translations.create.hi);

  const patchRes = await request(app)
    .patch(`/api/admin/broadcast/items/${created._id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ text: 'નવી ટિકર', lang: 'gu' })
    .expect(200);

  assert.equal(patchRes.body.ok, true);

  assert.equal(created.text, 'નવી ટિકર');
  assert.equal(created.text_i18n.gu, 'નવી ટિકર');
  assert.equal(created.text_i18n.en, translations.update.en);
  assert.equal(created.text_i18n.hi, translations.update.hi);

  // restore
  BroadcastItem.create = realCreate;
  BroadcastItem.findById = realFindById;
  guardedTranslate.translateWithGuardrails = origTranslate;
  mongoose.connection.readyState = prevReady;
});
