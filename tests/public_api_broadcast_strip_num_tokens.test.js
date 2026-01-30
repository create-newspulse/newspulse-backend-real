const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');

const BroadcastItem = require('../models/BroadcastItem');
const BroadcastSettings = require('../models/BroadcastSettings');

test('Public API Broadcast: strips leaked __NUM tokens from response (safety net)', async () => {
  const prevReady = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  const now = new Date();
  const breakingDocs = [
    { _id: 'b1', type: 'breaking', isLive: true, sourceLang: 'gu', text_i18n: { gu: 'ભાવ __NUM_0__ પર પહોંચ્યો 293000' }, createdAt: now, expiresAt: null },
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

  const res = await request(app)
    .get('/public-api/broadcast?lang=gu&nocache=1')
    .expect(200);

  assert.ok(Array.isArray(res.body.breaking.items));
  assert.ok(!String(res.body.breaking.items[0] || '').includes('__NUM'));

  mongoose.connection.readyState = prevReady;
});
