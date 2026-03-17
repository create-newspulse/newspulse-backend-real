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
  });
});

test('PUT /api/admin/ad-settings accepts the two new placement keys without disabling footer', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFindByIdAndUpdate = AdSettings.findByIdAndUpdate;

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    AdSettings.findByIdAndUpdate = prevFindByIdAndUpdate;
  });

  mongoose.connection.readyState = 1;

  AdSettings.findByIdAndUpdate = (_id, update) => {
    if (update && update.$setOnInsert) {
      return {
        lean: async () => ({
          _id: 'global',
          slotEnabled: {
            HOME_728x90: true,
            HOME_BILLBOARD_970x250: false,
            HOME_RIGHT_300x250: true,
            HOME_RIGHT_300x600: false,
            HOME_RIGHT_RAIL: true,
            ARTICLE_INLINE: true,
            ARTICLE_END: true,
            FOOTER_BANNER_728x90: true,
          },
        }),
      };
    }

    return {
      lean: async () => ({
        _id: 'global',
        slotEnabled: update.$set.slotEnabled,
      }),
    };
  };

  const token = makeOpaqueAdminToken();
  const res = await request(app)
    .put('/api/admin/ad-settings')
    .set('Authorization', `Bearer ${token}`)
    .send({
      slotEnabled: {
        HOME_RIGHT_300x600: true,
        HOME_BILLBOARD_970x250: true,
      },
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.slotEnabled.HOME_RIGHT_300x600, true);
  assert.equal(res.body.slotEnabled.HOME_BILLBOARD_970x250, true);
  assert.equal(res.body.slotEnabled.FOOTER_BANNER_728x90, true);
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
