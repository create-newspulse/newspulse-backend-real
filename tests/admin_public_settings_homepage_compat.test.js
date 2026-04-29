const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const PublicSiteSettings = require('../models/PublicSiteSettings');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function baseSettings() {
  return {
    publicSite: {
      homepage: {
        categoryStripEnabled: true,
      },
    },
    homepage: {
      modules: {
        categoryStrip: { enabled: true, order: 1 },
        trendingStrip: { enabled: true, order: 2 },
        exploreCategories: { enabled: true, order: 3 },
        liveTvCard: { enabled: true, order: 4 },
        quickTools: { enabled: true, order: 5 },
        appPromo: { enabled: true, order: 7 },
        footer: { enabled: true, order: 8 },
      },
    },
    tickers: {
      breaking: { enabled: true, speedSeconds: 30 },
      live: { enabled: true, speedSeconds: 25 },
    },
    liveTv: {
      enabled: true,
      embedUrl: '',
    },
    languageTheme: {
      languages: ['en', 'hi', 'gu'],
      themePreset: 'default',
    },
  };
}

function stubDbReady(t) {
  const prevReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
  });
}

test('GET /api/admin/settings/public preserves homepage settings response shape while adding isolated viral videos keys', async (t) => {
  stubDbReady(t);

  const prevGetOrCreate = PublicSiteSettings.getOrCreate;
  const prevGetDefaultSettings = PublicSiteSettings.getDefaultSettings;

  const draft = {
    ...baseSettings(),
    viralVideos: { enabled: false },
    viralVideosEnabled: false,
    homepage: {
      ...baseSettings().homepage,
      modules: {
        ...baseSettings().homepage.modules,
        viralVideos: { enabled: false, order: 11 },
        shortVideoDesk: { enabled: false, order: 11 },
      },
    },
  };
  const published = {
    ...draft,
  };

  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'production',
    version: 9,
    draft,
    published,
    updatedAt: new Date('2026-04-26T09:00:00.000Z'),
  });
  PublicSiteSettings.getDefaultSettings = () => baseSettings();

  t.after(() => {
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
    PublicSiteSettings.getDefaultSettings = prevGetDefaultSettings;
  });

  const res = await request(app)
    .get('/api/admin/settings/public')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.scope, 'production');
  assert.equal(res.body.version, 9);
  assert.equal(res.body.draft.publicSite.homepage.categoryStripEnabled, true);
  assert.equal(res.body.draft.homepage.modules.categoryStrip.enabled, true);
  assert.equal(res.body.draft.homepage.modules.categoryStrip.order, 1);
  assert.equal(res.body.draft.homepage.modules.trendingStrip.order, 2);
  assert.equal(res.body.draft.homepage.modules.exploreCategories.order, 3);
  assert.equal(res.body.draft.homepage.modules.liveTvCard.order, 4);
  assert.equal(res.body.draft.homepage.modules.quickTools.order, 5);
  assert.equal(res.body.draft.homepage.modules.appPromo.order, 7);
  assert.equal(res.body.draft.homepage.modules.footer.order, 8);
  assert.equal(res.body.published.publicSite.homepage.categoryStripEnabled, true);
  assert.equal(res.body.published.homepage.modules.categoryStrip.enabled, true);
  assert.equal(res.body.published.homepage.modules.categoryStrip.order, 1);
  assert.equal('viralVideos' in res.body.draft, false);
  assert.equal('viralVideosEnabled' in res.body.draft, false);
  assert.equal('viralVideos' in res.body.draft.homepage.modules, false);
  assert.equal('shortVideoDesk' in res.body.draft.homepage.modules, false);
  assert.equal('viralVideos' in res.body.published, false);
  assert.equal('viralVideosEnabled' in res.body.published, false);
});

test('PATCH /api/admin/settings/public keeps homepage settings shape stable when both tickers are off', async (t) => {
  stubDbReady(t);

  const prevGetOrCreate = PublicSiteSettings.getOrCreate;
  const prevGetDefaultSettings = PublicSiteSettings.getDefaultSettings;

  const settingsDoc = {
    scope: 'production',
    version: 4,
    draft: {
      ...baseSettings(),
      viralVideos: { enabled: false },
      viralVideosEnabled: false,
    },
    published: baseSettings(),
    updatedAt: new Date('2026-04-26T09:00:00.000Z'),
    async save() {
      this.updatedAt = new Date('2026-04-26T10:00:00.000Z');
      return this;
    },
  };

  PublicSiteSettings.getOrCreate = async () => settingsDoc;
  PublicSiteSettings.getDefaultSettings = () => baseSettings();

  t.after(() => {
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
    PublicSiteSettings.getDefaultSettings = prevGetDefaultSettings;
  });

  const res = await request(app)
    .patch('/api/admin/settings/public')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({
      tickers: {
        breaking: { enabled: false, speedSeconds: 30 },
        live: { enabled: false, speedSeconds: 25 },
      },
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.draft.publicSite.homepage.categoryStripEnabled, true);
  assert.equal(res.body.draft.homepage.modules.categoryStrip.enabled, true);
  assert.equal(res.body.draft.homepage.modules.categoryStrip.order, 1);
  assert.equal(res.body.draft.homepage.modules.trendingStrip.enabled, true);
  assert.equal(res.body.draft.homepage.modules.exploreCategories.enabled, true);
  assert.equal(res.body.draft.homepage.modules.liveTvCard.enabled, true);
  assert.equal(res.body.draft.homepage.modules.quickTools.enabled, true);
  assert.equal(res.body.draft.homepage.modules.appPromo.enabled, true);
  assert.equal(res.body.draft.homepage.modules.footer.enabled, true);
  assert.equal(res.body.draft.tickers.breaking.enabled, false);
  assert.equal(res.body.draft.tickers.live.enabled, false);
  assert.equal('viralVideos' in res.body.draft, false);
  assert.equal('viralVideosEnabled' in res.body.draft, false);
  assert.equal(res.body.published.publicSite.homepage.categoryStripEnabled, true);
  assert.equal(res.body.published.homepage.modules.categoryStrip.enabled, true);
  assert.equal(res.body.published.homepage.modules.categoryStrip.order, 1);
  assert.deepEqual(settingsDoc.draft.viralVideos, { enabled: false });
  assert.equal(settingsDoc.draft.viralVideosEnabled, false);
});

test('POST /api/admin/settings/public/publish succeeds when both tickers are off and keeps viral settings isolated from homepage response', async (t) => {
  stubDbReady(t);

  const prevGetOrCreate = PublicSiteSettings.getOrCreate;
  const prevGetDefaultSettings = PublicSiteSettings.getDefaultSettings;

  const settingsDoc = {
    scope: 'production',
    version: 6,
    draft: {
      ...baseSettings(),
      tickers: {
        breaking: { enabled: false, speedSeconds: 30 },
        live: { enabled: false, speedSeconds: 25 },
      },
      viralVideos: { enabled: false },
      viralVideosEnabled: false,
    },
    published: {
      ...baseSettings(),
      viralVideos: { enabled: false },
      viralVideosEnabled: false,
    },
    publishedUpdatedAt: new Date('2026-04-26T09:00:00.000Z'),
    updatedAt: new Date('2026-04-26T09:00:00.000Z'),
    async save() {
      this.updatedAt = new Date('2026-04-26T10:15:00.000Z');
      this.publishedUpdatedAt = new Date('2026-04-26T10:15:00.000Z');
      return this;
    },
  };

  PublicSiteSettings.getOrCreate = async () => settingsDoc;
  PublicSiteSettings.getDefaultSettings = () => baseSettings();

  t.after(() => {
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
    PublicSiteSettings.getDefaultSettings = prevGetDefaultSettings;
  });

  const res = await request(app)
    .post('/api/admin/settings/public/publish')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({});

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.version, 7);
  assert.equal(res.body.published.tickers.breaking.enabled, false);
  assert.equal(res.body.published.tickers.live.enabled, false);
  assert.equal(res.body.published.homepage.modules.categoryStrip.enabled, true);
  assert.equal(res.body.published.homepage.modules.trendingStrip.enabled, true);
  assert.equal(res.body.published.homepage.modules.exploreCategories.enabled, true);
  assert.equal(res.body.published.homepage.modules.liveTvCard.enabled, true);
  assert.equal(res.body.published.homepage.modules.quickTools.enabled, true);
  assert.equal(res.body.published.homepage.modules.appPromo.enabled, true);
  assert.equal(res.body.published.homepage.modules.footer.enabled, true);
  assert.equal('viralVideos' in res.body.published, false);
  assert.equal('viralVideosEnabled' in res.body.published, false);
  assert.deepEqual(settingsDoc.published.viralVideos, { enabled: false });
  assert.equal(settingsDoc.published.viralVideosEnabled, false);
});