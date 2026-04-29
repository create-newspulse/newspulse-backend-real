const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');

const PublicSiteSettings = require('../models/PublicSiteSettings');
const controller = require('../controllers/publicSiteSettingsController');
const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function homepageOffSettings() {
  return {
    categoryStrip: {
      enabled: false,
    },
    publicSite: {
      homepage: {
        categoryStripEnabled: false,
      },
    },
    homepage: {
      modules: {
        categoryStrip: { enabled: false, order: 1 },
        trending: { enabled: false, order: 2 },
        explore: { enabled: false, order: 3 },
        quickTools: { enabled: false, order: 5 },
        appPromo: { enabled: false, order: 7 },
        footer: { enabled: false, order: 8 },
      },
    },
    tickers: {
      breaking: { enabled: false, speedSeconds: 30 },
      liveUpdates: { enabled: false, speedSeconds: 25 },
    },
  };
}

function categoryStripOnSettings() {
  return {
    categoryStrip: {
      enabled: true,
    },
  };
}

function defaultDailyWonders() {
  return {
    enabled: true,
    showOnHomepage: true,
    label: 'DAILY WONDERS',
    title: 'Thought of the Day',
    subtitle: 'One meaningful thought to pause, reflect, and move through the day with clarity.',
    thoughtLabel: "TODAY'S THOUGHT",
    thoughtText: 'A peaceful mind does not come from a perfect day, but from choosing calm in the middle of it.',
    reminderLabel: 'GENTLE REMINDER',
    reminderText: 'You do not need to solve the whole day at once. One honest step is enough.',
    footerText: 'A small daily pause for calm, clarity, and inspiration.',
  };
}

function assertCategoryStripOn(settings) {
  assert.equal(settings.categoryStrip.enabled, true);
  assert.equal(settings.publicSite.homepage.categoryStripEnabled, true);
  assert.equal(settings.homepage.modules.categoryStrip.enabled, true);
}

function assertHomepageOff(published) {
  assert.equal(published.categoryStrip.enabled, false);
  assert.equal(published.publicSite.homepage.categoryStripEnabled, false);
  assert.equal(published.homepage.modules.categoryStrip.enabled, false);
  assert.equal(published.homepage.modules.trendingStrip.enabled, false);
  assert.equal(published.homepage.modules.trending.enabled, false);
  assert.equal(published.homepage.modules.exploreCategories.enabled, false);
  assert.equal(published.homepage.modules.explore.enabled, false);
  assert.equal(published.homepage.modules.quickTools.enabled, false);
  assert.equal(published.homepage.modules.appPromo.enabled, false);
  assert.equal(published.homepage.modules.footer.enabled, false);
  assert.equal(published.tickers.breaking.enabled, false);
  assert.equal(published.tickers.live.enabled, false);
  assert.equal(published.tickers.liveUpdates.enabled, false);
}

test('GET /api/public/settings returns published homepage modules OFF as OFF', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;
  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'development',
    version: 12,
    published: homepageOffSettings(),
    publishedUpdatedAt: new Date('2026-04-27T10:00:00.000Z'),
    updatedAt: new Date('2026-04-27T09:00:00.000Z'),
  });

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const res = await request(app).get('/api/public/settings');

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.version, 12);
  assertHomepageOff(res.body.published);
  assert.deepEqual(res.body.published.dailyWonders, defaultDailyWonders());
});

test('savePublicSettings stores top-level dailyWonders without changing inspirationHub or DroneTV fields', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;
  const prevGetDefaultSettings = PublicSiteSettings.getDefaultSettings;

  mongoose.connection.readyState = 1;

  const settingsDoc = {
    scope: 'development',
    version: 31,
    draft: {
      publicSite: { homepage: { categoryStripEnabled: true } },
      homepage: { modules: { categoryStrip: { enabled: true, order: 1 } } },
      inspirationHub: {
        enabled: true,
        droneTvEnabled: true,
        youtubeUrl: 'https://youtu.be/SLDHOwReM-Q',
        title: 'Inspiration Hub',
        droneTvTitle: 'DroneTV Live',
        dailyWondersTitle: 'Legacy hub daily title',
      },
    },
    published: {
      publicSite: { homepage: { categoryStripEnabled: true } },
      homepage: { modules: { categoryStrip: { enabled: true, order: 1 } } },
      dailyWonders: defaultDailyWonders(),
    },
    async save() {
      return this;
    },
  };

  PublicSiteSettings.getDefaultSettings = () => ({
    publicSite: { homepage: { categoryStripEnabled: true } },
    homepage: { modules: { categoryStrip: { enabled: true, order: 1 } } },
    dailyWonders: defaultDailyWonders(),
  });
  PublicSiteSettings.getOrCreate = async () => settingsDoc;

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
    PublicSiteSettings.getDefaultSettings = prevGetDefaultSettings;
  });

  const req = {
    method: 'PATCH',
    body: {
      dailyWonders: {
        enabled: true,
        showOnHomepage: true,
        thoughtText: 'Updated thought for the frontend.',
        reminderText: 'Updated reminder for the frontend.',
        publishDate: '2026-04-29',
      },
    },
  };
  const res = createRes();

  await controller.savePublicSettings(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.draft.dailyWonders.thoughtText, 'Updated thought for the frontend.');
  assert.equal(res.body.draft.dailyWonders.reminderText, 'Updated reminder for the frontend.');
  assert.equal(res.body.draft.dailyWonders.publishDate, '2026-04-29');
  assert.equal(res.body.draft.dailyWonders.title, 'Thought of the Day');
  assert.equal(res.body.draft.inspirationHub.droneTvEnabled, true);
  assert.equal(res.body.draft.inspirationHub.droneTvTitle, 'DroneTV Live');
  assert.equal(res.body.draft.inspirationHub.dailyWondersTitle, 'Legacy hub daily title');
});

test('publishSettings exposes updated dailyWonders for frontend reads', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;

  const updatedDailyWonders = {
    ...defaultDailyWonders(),
    thoughtText: 'A fresh thought from admin.',
    reminderText: 'A fresh reminder from admin.',
  };
  const settingsDoc = {
    scope: 'development',
    version: 40,
    draft: {
      publicSite: { homepage: { categoryStripEnabled: true } },
      homepage: { modules: { categoryStrip: { enabled: true, order: 1 } } },
      dailyWonders: updatedDailyWonders,
    },
    published: homepageOffSettings(),
    publishedUpdatedAt: new Date('2026-04-28T10:00:00.000Z'),
    async save() {
      return this;
    },
  };

  PublicSiteSettings.getOrCreate = async () => settingsDoc;

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const publishRes = createRes();
  await controller.publishSettings({}, publishRes);

  assert.equal(publishRes.statusCode, 200);
  assert.equal(publishRes.body.published.dailyWonders.thoughtText, 'A fresh thought from admin.');
  assert.equal(publishRes.body.published.dailyWonders.reminderText, 'A fresh reminder from admin.');

  const publicRes = await request(app).get('/api/public/settings');

  assert.equal(publicRes.status, 200);
  assert.equal(publicRes.body.ok, true);
  assert.equal(publicRes.body.published.dailyWonders.thoughtText, 'A fresh thought from admin.');
  assert.equal(publicRes.body.published.dailyWonders.reminderText, 'A fresh reminder from admin.');
});

test('savePublicSettings rejects invalid dailyWonders field types', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;
  PublicSiteSettings.getOrCreate = async () => ({
    draft: { dailyWonders: defaultDailyWonders() },
    published: { dailyWonders: defaultDailyWonders() },
    async save() {},
  });

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const res = createRes();
  await controller.savePublicSettings({ method: 'PATCH', body: { dailyWonders: { enabled: 'yes' } } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'Invalid type for dailyWonders.enabled: expected boolean');
});

test('savePublicSettings stores canonical categoryStrip.enabled ON in draft shape', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;
  const prevGetDefaultSettings = PublicSiteSettings.getDefaultSettings;

  mongoose.connection.readyState = 1;

  let saveCalls = 0;
  PublicSiteSettings.getDefaultSettings = () => ({
    categoryStrip: { enabled: false },
    publicSite: { homepage: { categoryStripEnabled: false } },
    homepage: { modules: { categoryStrip: { enabled: false, order: 1 } } },
  });
  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'development',
    version: 2,
    draft: {
      categoryStrip: { enabled: false },
      publicSite: { homepage: { categoryStripEnabled: false } },
      homepage: { modules: { categoryStrip: { enabled: false, order: 1 } } },
    },
    published: {
      categoryStrip: { enabled: false },
      publicSite: { homepage: { categoryStripEnabled: false } },
      homepage: { modules: { categoryStrip: { enabled: false, order: 1 } } },
    },
    async save() {
      saveCalls += 1;
    },
  });

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
    PublicSiteSettings.getDefaultSettings = prevGetDefaultSettings;
  });

  const req = {
    method: 'PATCH',
    body: categoryStripOnSettings(),
  };
  const res = createRes();

  await controller.savePublicSettings(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(saveCalls, 1);
  assertCategoryStripOn(res.body.draft);
  assert.equal(res.body.draft.homepage.modules.categoryStrip.order, 1);
});

test('publishSettings promotes canonical categoryStrip.enabled ON into published settings', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;

  let saveCalls = 0;
  const settingsDoc = {
    scope: 'development',
    version: 8,
    draft: categoryStripOnSettings(),
    published: homepageOffSettings(),
    async save() {
      saveCalls += 1;
    },
  };

  PublicSiteSettings.getOrCreate = async () => settingsDoc;

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const res = createRes();
  await controller.publishSettings({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(saveCalls, 1);
  assert.equal(res.body.version, 9);
  assertCategoryStripOn(res.body.published);
});

test('GET /api/public/settings returns published categoryStrip.enabled ON as ON', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;
  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'development',
    version: 13,
    published: categoryStripOnSettings(),
    publishedUpdatedAt: new Date('2026-04-27T11:00:00.000Z'),
    updatedAt: new Date('2026-04-27T10:00:00.000Z'),
  });

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const res = await request(app).get('/api/public/settings');

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.version, 13);
  assertCategoryStripOn(res.body.published);
});

test('admin save draft refetch publish flow keeps categoryStrip.enabled ON', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;
  const prevGetDefaultSettings = PublicSiteSettings.getDefaultSettings;

  mongoose.connection.readyState = 1;

  const settingsDoc = {
    scope: 'development',
    version: 21,
    draft: homepageOffSettings(),
    published: homepageOffSettings(),
    updatedAt: new Date('2026-04-27T10:00:00.000Z'),
    publishedUpdatedAt: new Date('2026-04-27T10:00:00.000Z'),
    async save() {
      this.updatedAt = new Date('2026-04-27T10:05:00.000Z');
      return this;
    },
  };

  PublicSiteSettings.getDefaultSettings = () => homepageOffSettings();
  PublicSiteSettings.getOrCreate = async () => settingsDoc;

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
    PublicSiteSettings.getDefaultSettings = prevGetDefaultSettings;
  });

  const auth = `Bearer ${makeOpaqueAdminToken()}`;

  const saveRes = await request(app)
    .patch('/api/admin/settings/public')
    .set('Authorization', auth)
    .send({ categoryStrip: { enabled: true } });

  assert.equal(saveRes.status, 200);
  assertCategoryStripOn(saveRes.body.draft);
  assertCategoryStripOn(settingsDoc.draft);

  const adminReadRes = await request(app)
    .get('/api/admin/settings/public')
    .set('Authorization', auth);

  assert.equal(adminReadRes.status, 200);
  assertCategoryStripOn(adminReadRes.body.draft);

  const publishRes = await request(app)
    .post('/api/admin/settings/public/publish')
    .set('Authorization', auth);

  assert.equal(publishRes.status, 200);
  assertCategoryStripOn(publishRes.body.published);
  assertCategoryStripOn(settingsDoc.published);

  const publicReadRes = await request(app).get('/api/public/settings');

  assert.equal(publicReadRes.status, 200);
  assertCategoryStripOn(publicReadRes.body.published);
});

test('publishSettings copies draft OFF homepage modules into published settings', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;

  let saveCalls = 0;
  const settingsDoc = {
    scope: 'development',
    version: 4,
    draft: homepageOffSettings(),
    published: {
      publicSite: { homepage: { categoryStripEnabled: true } },
      homepage: { modules: { categoryStrip: { enabled: true, order: 1 } } },
      tickers: { breaking: { enabled: true }, live: { enabled: true } },
    },
    async save() {
      saveCalls += 1;
    },
  };

  PublicSiteSettings.getOrCreate = async () => settingsDoc;

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const res = createRes();
  await controller.publishSettings({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(saveCalls, 1);
  assert.equal(res.body.version, 5);
  assertHomepageOff(res.body.published);
});
