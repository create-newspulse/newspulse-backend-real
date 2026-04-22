const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const PublicConfigVersion = require('../models/PublicConfigVersion');
const AdSettings = require('../models/AdSettings');
const Ad = require('../models/Ad');
const BroadcastItem = require('../models/BroadcastItem');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const SponsoredFeature = require('../models/SponsoredFeature');
const SystemSetting = require('../models/SystemSetting');
const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function mockPublicConfigVersionStore(t, initialVersion = 0) {
  const prevFindOne = PublicConfigVersion.findOne;
  const prevFindOneAndUpdate = PublicConfigVersion.findOneAndUpdate;
  const prevReadyState = mongoose.connection.readyState;

  let current = {
    key: 'public',
    version: initialVersion,
    updatedAt: new Date('2026-03-18T00:00:00.000Z'),
  };

  mongoose.connection.readyState = 1;

  PublicConfigVersion.findOne = () => ({
    lean: async () => ({ ...current }),
  });

  PublicConfigVersion.findOneAndUpdate = (_filter, update) => ({
    lean: async () => {
      const next = update && update.$set ? update.$set : {};
      current = {
        key: 'public',
        version: typeof next.version === 'number' ? next.version : current.version,
        updatedAt: next.updatedAt || new Date(),
      };
      return { ...current };
    },
  });

  t.after(() => {
    PublicConfigVersion.findOne = prevFindOne;
    PublicConfigVersion.findOneAndUpdate = prevFindOneAndUpdate;
    mongoose.connection.readyState = prevReadyState;
  });

  return {
    getCurrent() {
      return { ...current };
    },
  };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForVersionAbove(minVersion) {
  let lastResponse = null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    lastResponse = await request(app).get('/api/public/version');
    if (lastResponse.status === 200 && Number(lastResponse.body.version) > minVersion) {
      return lastResponse;
    }
  }

  return lastResponse;
}

test('GET /api/public/version returns version payload with no-store headers', async (t) => {
  const store = mockPublicConfigVersionStore(t, 1234567890);
  const seeded = store.getCurrent();

  const res = await request(app).get('/api/public/version');

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.success, true);
  assert.equal(res.body.version, seeded.version);
  assert.equal(res.body.updatedAt, seeded.updatedAt.toISOString());
  assert.match(String(res.headers['cache-control'] || ''), /no-store/i);
});

test('PUT /api/admin/ad-settings bumps public config version', async (t) => {
  const store = mockPublicConfigVersionStore(t, 50);
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

  AdSettings.findByIdAndUpdate = (_id, update) => {
    if (update && update.$setOnInsert) {
      return {
        lean: async () => ({ _id: 'global', slotEnabled: persistedSlotEnabled }),
      };
    }

    persistedSlotEnabled = update.$set.slotEnabled;
    return {
      lean: async () => ({ _id: 'global', slotEnabled: persistedSlotEnabled }),
    };
  };

  AdSettings.updateOne = async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });

  t.after(() => {
    AdSettings.findByIdAndUpdate = prevFindByIdAndUpdate;
    AdSettings.updateOne = prevUpdateOne;
  });

  const res = await request(app)
    .put('/api/admin/ad-settings')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({
      slotEnabled: {
        BREAKING_SPONSOR: true,
      },
    });

  assert.equal(res.status, 200);
  await flushAsyncWork();

  const versionRes = await waitForVersionAbove(50);
  assert.equal(versionRes.status, 200);
  assert.ok(versionRes.body.version > 50);
});

test('POST /api/admin/ads bumps public config version', async (t) => {
  mockPublicConfigVersionStore(t, 75);
  const prevCreate = Ad.create;

  Ad.create = async (payload) => ({
    _id: payload._id,
    slot: payload.slot,
    title: payload.title,
    imageUrl: payload.imageUrl,
    originalImageUrl: payload.originalImageUrl || null,
    isClickable: payload.isClickable,
    targetUrl: payload.targetUrl,
    isActive: payload.isActive !== false,
    startAt: payload.startAt || null,
    endAt: payload.endAt || null,
    priority: payload.priority || 0,
    createdBy: payload.createdBy || null,
    createdAt: new Date(),
    updatedAt: new Date(),
    stats: payload.stats || { impressions: 0, clicks: 0 },
  });

  t.after(() => {
    Ad.create = prevCreate;
  });

  const res = await request(app)
    .post('/api/admin/ads')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({
      slot: 'HOME_728x90',
      title: 'Homepage Sponsor',
      imageUrl: 'https://example.com/ad.png',
      targetUrl: 'https://example.com',
      isActive: true,
      priority: 10,
    });

  assert.equal(res.status, 201);
  await flushAsyncWork();

  const versionRes = await waitForVersionAbove(75);
  assert.equal(versionRes.status, 200);
  assert.ok(versionRes.body.version > 75);
});

test('POST /api/admin/broadcast/items bumps public config version', async (t) => {
  mockPublicConfigVersionStore(t, 100);
  const prevCreate = BroadcastItem.create;

  BroadcastItem.create = async (payload) => ({
    _id: new mongoose.Types.ObjectId(),
    type: payload.type,
    text: payload.text,
    sourceLang: payload.sourceLang,
    language: payload.language,
    text_i18n: payload.text_i18n,
    textByLang: payload.textByLang,
    statusByLang: payload.statusByLang,
    qualityByLang: payload.qualityByLang,
    translations: payload.translations,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
    isLive: true,
  });

  t.after(() => {
    BroadcastItem.create = prevCreate;
  });

  const res = await request(app)
    .post('/api/admin/broadcast/items')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({
      type: 'breaking',
      text: 'Major update just in',
      lang: 'en',
      expiresInHours: 24,
      autoTranslate: false,
    });

  assert.equal(res.status, 201);
  await flushAsyncWork();

  const versionRes = await waitForVersionAbove(100);
  assert.equal(versionRes.status, 200);
  assert.ok(versionRes.body.version > 100);
});

test('PUT /api/admin/public-settings bumps public config version', async (t) => {
  mockPublicConfigVersionStore(t, 125);
  const prevFindOneAndUpdate = SystemSetting.findOneAndUpdate;

  SystemSetting.findOneAndUpdate = () => ({
    lean: async () => ({
      key: 'settings_center_public',
      updatedAt: new Date('2026-03-18T10:00:00.000Z'),
    }),
  });

  t.after(() => {
    SystemSetting.findOneAndUpdate = prevFindOneAndUpdate;
  });

  const res = await request(app)
    .put('/api/admin/public-settings')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({
      publicSite: {
        footer: {
          links: [{ label: 'About', href: '/about' }],
        },
      },
    });

  assert.equal(res.status, 200);
  await flushAsyncWork();

  const versionRes = await waitForVersionAbove(125);
  assert.equal(versionRes.status, 200);
  assert.ok(versionRes.body.version > 125);
});

test('POST /api/admin/settings/public/publish bumps public config version', async (t) => {
  mockPublicConfigVersionStore(t, 150);
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  const settingsDoc = {
    scope: 'production',
    version: 4,
    draft: {
      homepage: {
        modules: {
          spotlight: { enabled: true, order: 2 },
        },
      },
    },
    published: {
      homepage: {
        modules: {
          spotlight: { enabled: false, order: 1 },
        },
      },
    },
    publishedUpdatedAt: null,
    updatedAt: new Date('2026-03-18T09:00:00.000Z'),
    async save() {
      this.updatedAt = new Date('2026-03-18T11:00:00.000Z');
      return this;
    },
  };

  PublicSiteSettings.getOrCreate = async () => settingsDoc;

  t.after(() => {
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const res = await request(app)
    .post('/api/admin/settings/public/publish')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({});

  assert.equal(res.status, 200);
  await flushAsyncWork();

  const versionRes = await waitForVersionAbove(150);
  assert.equal(versionRes.status, 200);
  assert.ok(versionRes.body.version > 150);
});

test('PATCH /api/admin/sponsored-features/:id/toggle bumps public config version', async (t) => {
  mockPublicConfigVersionStore(t, 175);
  const prevFindById = SponsoredFeature.findById;

  const featureDoc = {
    _id: new mongoose.Types.ObjectId(),
    title: 'Homepage Sponsor',
    placementKey: 'homepage',
    placement: 'homepage',
    isActive: true,
    linkedArticleId: null,
    async save() {
      return this;
    },
  };

  SponsoredFeature.findById = async (id) => {
    if (String(id) !== String(featureDoc._id)) return null;
    return featureDoc;
  };

  t.after(() => {
    SponsoredFeature.findById = prevFindById;
  });

  const res = await request(app)
    .patch(`/api/admin/sponsored-features/${featureDoc._id.toString()}/toggle`)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ isActive: false });

  assert.equal(res.status, 200);
  await flushAsyncWork();

  const versionRes = await waitForVersionAbove(175);
  assert.equal(versionRes.status, 200);
  assert.ok(versionRes.body.version > 175);
});

test('PATCH /api/admin/ticker/:id bumps public config version', async (t) => {
  mockPublicConfigVersionStore(t, 200);
  const prevFindById = BroadcastItem.findById;

  const tickerDoc = {
    _id: new mongoose.Types.ObjectId(),
    text: 'Original ticker text',
    sourceLang: 'en',
    language: 'en',
    set(key, value) {
      this[key] = value;
    },
    async save() {
      return this;
    },
  };

  BroadcastItem.findById = async (id) => {
    if (String(id) !== String(tickerDoc._id)) return null;
    return tickerDoc;
  };

  t.after(() => {
    BroadcastItem.findById = prevFindById;
  });

  const res = await request(app)
    .patch(`/api/admin/ticker/${tickerDoc._id.toString()}`)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ isActive: false });

  assert.equal(res.status, 200);
  await flushAsyncWork();

  const versionRes = await waitForVersionAbove(200);
  assert.equal(versionRes.status, 200);
  assert.ok(versionRes.body.version > 200);
});