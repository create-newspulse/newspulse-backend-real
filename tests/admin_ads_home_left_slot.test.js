const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

const Ad = require('../models/Ad');

const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function stubDbReady(t) {
  const prevReadyState = mongoose.connection.readyState;
  t.after(() => { mongoose.connection.readyState = prevReadyState; });
  mongoose.connection.readyState = 1;
}

test('GET /api/admin/ads lists HOME_LEFT_300x250 ads by exact slot without aliasing', async (t) => {
  stubDbReady(t);

  const prevFind = Ad.find;
  t.after(() => { Ad.find = prevFind; });

  let capturedFilter = null;
  Ad.find = (filter) => {
    capturedFilter = filter;
    return {
      sort() { return this; },
      lean: async () => ([{
        _id: '507f1f77bcf86cd799439301',
        slot: 'HOME_LEFT_300x250',
        title: 'Home Left Rail Ad',
        imageUrl: 'https://example.com/home-left-rail.jpg',
        isClickable: true,
        targetUrl: 'https://example.com',
        isActive: true,
        startAt: null,
        endAt: null,
        priority: 5,
        stats: { impressions: 0, clicks: 0 },
        createdAt: new Date('2026-04-24T00:00:00.000Z'),
        updatedAt: new Date('2026-04-24T00:00:00.000Z'),
      }]),
    };
  };

  const res = await request(app)
    .get('/api/admin/ads?slot=HOME_LEFT_300x250')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

  assert.equal(res.status, 200);
  assert.deepEqual(capturedFilter, { slot: 'HOME_LEFT_300x250' });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.ads.length, 1);
  assert.equal(res.body.ads[0].slot, 'HOME_LEFT_300x250');
});

test('POST /api/admin/ads creates HOME_LEFT_300x250 as a first-class slot', async (t) => {
  stubDbReady(t);

  const prevCreate = Ad.create;
  t.after(() => { Ad.create = prevCreate; });

  Ad.create = async (payload) => ({
    _id: payload._id,
    slot: payload.slot,
    title: payload.title,
    imageUrl: payload.imageUrl,
    originalImageUrl: payload.originalImageUrl || null,
    isClickable: payload.isClickable,
    targetUrl: payload.targetUrl,
    isActive: payload.isActive,
    startAt: payload.startAt,
    endAt: payload.endAt,
    priority: payload.priority,
    createdBy: payload.createdBy,
    createdAt: new Date('2026-04-24T00:00:00.000Z'),
    updatedAt: new Date('2026-04-24T00:00:00.000Z'),
    stats: payload.stats,
  });

  const res = await request(app)
    .post('/api/admin/ads')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({
      slot: 'HOME_LEFT_300x250',
      title: 'Home Left Rail Ad',
      imageUrl: 'https://example.com/home-left-rail.jpg',
      targetUrl: 'https://example.com',
      isActive: true,
      startAt: '2026-04-24T00:00:00.000Z',
      endAt: '2026-04-25T00:00:00.000Z',
      priority: 7,
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.ad.slot, 'HOME_LEFT_300x250');
  assert.equal(res.body.ad.priority, 7);
});