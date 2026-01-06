const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const SiteSetting = require('../models/SiteSetting');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const BroadcastSettings = require('../models/BroadcastSettings');

let store = null;

function resetStore() {
  store = {
    draft: null,
    published: null,
    version: 0,
    updatedAt: null,
    publishedAt: null,
  };
}

function makeQuery(resultFactory) {
  return {
    _lean: false,
    _sort: null,
    lean() {
      this._lean = true;
      return this;
    },
    sort(s) {
      this._sort = s;
      return this;
    },
    async then(resolve, reject) {
      try {
        const result = typeof resultFactory === 'function' ? resultFactory(this) : resultFactory;
        return resolve(result);
      } catch (e) {
        return reject(e);
      }
    },
  };
}

resetStore();

const origSiteSettingFindOne = SiteSetting.findOne;
const origSiteSettingFindOneAndUpdate = SiteSetting.findOneAndUpdate;
const origSiteSettingCreate = SiteSetting.create;
const origPublicSiteSettingsFindOne = PublicSiteSettings.findOne;
const origPublicSiteSettingsFindOneAndUpdate = PublicSiteSettings.findOneAndUpdate;
const origBroadcastFindOne = BroadcastSettings.findOne;

function publicDocSnapshot() {
  return {
    scope: 'public',
    draft: store.draft,
    published: store.published,
    version: store.version,
    updatedAt: store.updatedAt,
    publishedAt: store.publishedAt,
    createdAt: store.updatedAt,
  };
}

// SiteSetting is now legacy/fallback for these endpoints; keep it inert for this test.
SiteSetting.findOne = (_filter) => makeQuery(null);
SiteSetting.findOneAndUpdate = async () => null;
SiteSetting.create = async (payload) => payload;

PublicSiteSettings.findOne = (filter) => {
  return makeQuery((q) => {
    if (!filter || filter.scope !== 'public') return null;
    const base = publicDocSnapshot();
    return q._lean ? base : { ...base };
  });
};

PublicSiteSettings.findOneAndUpdate = async (filter, update) => {
  if (!filter || filter.scope !== 'public') return null;
  const set = (update && update.$set) ? update.$set : {};
  if (Object.prototype.hasOwnProperty.call(set, 'draft')) store.draft = set.draft;
  if (Object.prototype.hasOwnProperty.call(set, 'published')) store.published = set.published;
  if (Object.prototype.hasOwnProperty.call(set, 'version')) store.version = set.version;
  if (Object.prototype.hasOwnProperty.call(set, 'publishedAt')) store.publishedAt = set.publishedAt;
  store.updatedAt = new Date();
  return publicDocSnapshot();
};

BroadcastSettings.findOne = () => makeQuery(null);

// --- Tests ---

test('Admin: save draft -> publish -> public returns updated values', async () => {
  const prev = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  resetStore();

    // Admin endpoints must echo back exactly what was saved.
    const draftPayload = {
      tickers: {
        breaking: { enabled: false, speedSeconds: '9' },
        live: { enabled: true, speedSeconds: '11' },
      },
    };

  const save = await request(app)
    .put('/api/admin/settings/public/draft')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send(draftPayload);

  assert.equal(save.status, 200);
  assert.ok(save.body && save.body.ok === true);
  assert.ok(save.body.data && save.body.data.draft, 'PUT draft should return data.draft');

  const getDraft = await request(app)
    .get('/api/admin/settings/public/draft')
    .set('Cookie', 'np_admin=admin@newspulse.ai');
  assert.equal(getDraft.status, 200);
  assert.ok(getDraft.body && getDraft.body.ok === true);
  assert.ok(getDraft.body.data && getDraft.body.data.draft, 'GET draft should return data.draft');
  assert.equal(getDraft.body.data.draft.tickers.breaking.enabled, false);
  assert.equal(getDraft.body.data.draft.tickers.breaking.speedSeconds, '9');
  assert.equal(getDraft.body.data.draft.tickers.live.enabled, true);
  assert.equal(getDraft.body.data.draft.tickers.live.speedSeconds, '11');

  // publish
  const pub = await request(app)
    .post('/api/admin/settings/public/publish')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();

  assert.equal(pub.status, 200);
  assert.ok(pub.body && pub.body.ok === true);
  assert.ok(pub.body.meta);
  assert.equal(pub.body.meta.version, 1);

  // Admin panel relies on these fields being present in the publish response
  const published = pub.body.published || (pub.body.data && pub.body.data.published);
  assert.ok(published);
  assert.ok(pub.body.data && pub.body.data.published, 'POST publish should return data.published');
  assert.deepEqual(published, draftPayload);

  // Admin GET should return both draft + published in a stable shape
  const adminGet = await request(app)
    .get('/api/admin/settings/public')
    .set('Cookie', 'np_admin=admin@newspulse.ai');
  assert.equal(adminGet.status, 200);
  assert.ok(adminGet.body && adminGet.body.ok === true);
  assert.ok(adminGet.body.data && adminGet.body.data.draft);
  assert.ok(adminGet.body.data && adminGet.body.data.published);
  assert.equal(adminGet.body.meta.version, 1);
  assert.deepEqual(adminGet.body.data.published, draftPayload);

  // public
  const res = await request(app).get('/api/public/settings');
  assert.equal(res.status, 200);
  assert.equal(String(res.headers['cache-control'] || ''), 'no-store');

  assert.ok(res.body && res.body.ok === true);
  assert.ok(res.body.data && res.body.data.tickers);
  // Public endpoint normalizes for frontend safety (coerces string numbers, fills defaults)
  assert.equal(res.body.data.tickers.breaking.enabled, false);
  assert.equal(res.body.data.tickers.breaking.speedSeconds, 9);
  assert.equal(res.body.data.tickers.live.enabled, true);
  assert.equal(res.body.data.tickers.live.speedSeconds, 11);

  mongoose.connection.readyState = prev;
});

test('Public: /api/public/settings is mounted and returns 200 with tickers keys', async () => {
  const prev = mongoose.connection.readyState;
  mongoose.connection.readyState = 0;

  const res = await request(app).get('/api/public/settings');
  assert.equal(res.status, 200);
  assert.ok(res.body && res.body.ok === true);
  assert.ok(res.body.data);
  assert.equal(typeof res.body.data.tickers, 'object');
  assert.equal(typeof res.body.data.tickers.breaking, 'object');
  assert.equal(typeof res.body.data.tickers.live, 'object');

  // These are expected to be ON by default.
  assert.ok(res.body.data.homeModules);
  assert.equal(res.body.data.homeModules.categoryStrip.enabled, true);
  assert.equal(res.body.data.homeModules.trendingStrip.enabled, true);
  assert.equal(res.body.data.homeModules.exploreCategories.enabled, true);
  assert.equal(res.body.data.homeModules.liveUpdatesTicker.enabled, true);
  assert.equal(res.body.data.homeModules.breakingTicker.enabled, true);
  assert.equal(res.body.data.homeModules.quickTools.enabled, true);
  assert.equal(res.body.data.homeModules.appPromo.enabled, true);
  assert.equal(res.body.data.homeModules.snapshots.enabled, true);
  assert.equal(res.body.data.homeModules.liveTV.enabled, true);
  assert.equal(res.body.data.homeModules.footer.enabled, true);

  mongoose.connection.readyState = prev;
});

test('Admin: publish endpoint is mounted and requires auth (401, not 404)', async () => {
  const res = await request(app)
    .post('/api/admin/settings/public/publish')
    .send();
  assert.equal(res.status, 401);
});

test('Admin: draft endpoint GET is not 404 (returns 405)', async () => {
  const res = await request(app)
    .get('/api/admin/settings/public/draft');
  // Requires auth, but should be mounted (401, not 404)
  assert.equal(res.status, 401);
});

// Restore patched methods (best-effort)
test('cleanup', () => {
  SiteSetting.findOne = origSiteSettingFindOne;
  SiteSetting.findOneAndUpdate = origSiteSettingFindOneAndUpdate;
  SiteSetting.create = origSiteSettingCreate;
  PublicSiteSettings.findOne = origPublicSiteSettingsFindOne;
  PublicSiteSettings.findOneAndUpdate = origPublicSiteSettingsFindOneAndUpdate;
  BroadcastSettings.findOne = origBroadcastFindOne;
});
