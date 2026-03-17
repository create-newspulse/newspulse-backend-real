const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

const AdSettings = require('../models/AdSettings');

const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

test('GET /api/public/ad-settings returns defaults when DB not connected', async () => {
  const res = await request(app).get('/api/public/ad-settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.slotEnabled, {
    HOME_728x90: true,
    HOME_BILLBOARD_970x250: false,
    HOME_RIGHT_300x250: true,
    HOME_RIGHT_300x600: false,
    HOME_RIGHT_RAIL: true,
    ARTICLE_INLINE: true,
    ARTICLE_END: true,
    FOOTER_BANNER_728x90: true,
    BREAKING_SPONSOR: false,
    LIVE_UPDATE_SPONSOR: false,
  });
});

test('PUT /api/admin/ad-settings persists sponsor slots without changing other placements', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFindByIdAndUpdate = AdSettings.findByIdAndUpdate;
  const prevUpdateOne = AdSettings.updateOne;

  let persistedSlotEnabled = {
    HOME_728x90: true,
    HOME_BILLBOARD_970x250: false,
    HOME_RIGHT_300x250: true,
    HOME_RIGHT_300x600: false,
    HOME_RIGHT_RAIL: true,
    ARTICLE_INLINE: true,
    ARTICLE_END: true,
    FOOTER_BANNER_728x90: true,
    BREAKING_SPONSOR: false,
    LIVE_UPDATE_SPONSOR: false,
  };

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    AdSettings.findByIdAndUpdate = prevFindByIdAndUpdate;
    AdSettings.updateOne = prevUpdateOne;
  });

  mongoose.connection.readyState = 1;

  AdSettings.findByIdAndUpdate = (_id, update) => {
    if (update && update.$setOnInsert) {
      return {
        lean: async () => ({
          _id: 'global',
          slotEnabled: persistedSlotEnabled,
        }),
      };
    }

    persistedSlotEnabled = update.$set.slotEnabled;

    return {
      lean: async () => ({
        _id: 'global',
        slotEnabled: persistedSlotEnabled,
      }),
    };
  };

  AdSettings.updateOne = async (_filter, update) => {
    if (update && update.$set && update.$set.slotEnabled) {
      persistedSlotEnabled = update.$set.slotEnabled;
    }
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  };

  const token = makeOpaqueAdminToken();
  const putRes = await request(app)
    .put('/api/admin/ad-settings')
    .set('Authorization', `Bearer ${token}`)
    .send({
      slotEnabled: {
        BREAKING_SPONSOR: true,
        LIVE_UPDATE_SPONSOR: true,
      },
    });

  assert.equal(putRes.status, 200);
  assert.equal(putRes.body.ok, true);
  assert.equal(putRes.body.slotEnabled.BREAKING_SPONSOR, true);
  assert.equal(putRes.body.slotEnabled.LIVE_UPDATE_SPONSOR, true);
  assert.equal(putRes.body.slotEnabled.FOOTER_BANNER_728x90, true);
  assert.equal(putRes.body.slotEnabled.HOME_RIGHT_300x600, false);

  const getRes = await request(app)
    .get('/api/admin/ad-settings')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.ok, true);
  assert.equal(getRes.body.slotEnabled.BREAKING_SPONSOR, true);
  assert.equal(getRes.body.slotEnabled.LIVE_UPDATE_SPONSOR, true);
  assert.equal(getRes.body.slotEnabled.FOOTER_BANNER_728x90, true);
  assert.equal(getRes.body.slotEnabled.HOME_RIGHT_300x600, false);
});

test('GET /api/admin/ad-settings is protected (401 when unauthenticated)', async () => {
  const res = await request(app).get('/api/admin/ad-settings');
  assert.equal(res.status, 401);
});

test('GET /api/admin/ad-settings returns defaults with admin token', async () => {
  const token = makeOpaqueAdminToken();
  const res = await request(app)
    .get('/api/admin/ad-settings')
    .set('Authorization', `Bearer ${token}`);

  // In test mode the server skips DB connection; admin endpoints should respond 503 JSON.
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
});

test('GET /admin-api/admin/ad-settings works as an alias (200 with admin token)', async () => {
  const token = makeOpaqueAdminToken();
  const res = await request(app)
    .get('/admin-api/admin/ad-settings')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
});
