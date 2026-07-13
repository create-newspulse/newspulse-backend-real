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

function baseSettings(liveTv = {}) {
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
      },
    },
    tickers: {
      breaking: { enabled: true, speedSeconds: 30 },
      live: { enabled: true, speedSeconds: 25 },
    },
    liveTv: {
      enabled: true,
      status: 'replay',
      mode: 'Offline Replay',
      provider: 'YouTube',
      embedUrl: '',
      fallbackVideoUrl: '',
      title: 'News Pulse Live',
      subtitle: '',
      language: 'English',
      showOnHomepage: true,
      startTime: '',
      endTime: '',
      nextLiveTime: '',
      updatedAt: '',
      ...liveTv,
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

function stubPublicSiteSettings(t, settingsDoc) {
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;
  const prevGetDefaultSettings = PublicSiteSettings.getDefaultSettings;

  PublicSiteSettings.getOrCreate = async () => settingsDoc;
  PublicSiteSettings.getDefaultSettings = () => baseSettings();

  t.after(() => {
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
    PublicSiteSettings.getDefaultSettings = prevGetDefaultSettings;
  });
}

test('GET /admin/settings/public-site/live-tv returns current Live TV settings from PublicSiteSettings', async (t) => {
  stubDbReady(t);

  const settingsDoc = {
    scope: 'production',
    version: 4,
    updatedAt: new Date('2026-07-09T08:00:00.000Z'),
    draft: baseSettings({
      status: 'scheduled',
      mode: 'scheduled-show',
      provider: 'youtube',
      offlinePosterImageUrl: '/uploads/media-library/settings-poster.webp',
      offlineLoopVideoUrl: '/uploads/media-library/settings-loop.webm',
      offlineMessage: 'Offline settings message',
      startTime: '2026-07-09T10:00:00.000Z',
      nextLiveTime: '2026-07-09T10:00:00.000Z',
    }),
    published: baseSettings({ status: 'replay' }),
  };
  stubPublicSiteSettings(t, settingsDoc);

  const res = await request(app)
    .get('/admin/settings/public-site/live-tv')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.liveTv.status, 'scheduled');
  assert.equal(res.body.liveTv.mode, 'scheduled-show');
  assert.equal(res.body.liveTv.provider, 'youtube');
  assert.equal(res.body.liveTv.offlinePosterImageUrl, '/uploads/media-library/settings-poster.webp');
  assert.equal(res.body.liveTv.offlineLoopVideoUrl, '/uploads/media-library/settings-loop.webm');
  assert.equal(res.body.liveTv.offlineMessage, 'Offline settings message');
  assert.equal(res.body.liveTv.startTime, '2026-07-09T10:00:00.000Z');
  assert.equal(res.body.published.status, 'replay');
});

test('PATCH /api/admin/live-tv updates draft Live TV settings without a separate system', async (t) => {
  stubDbReady(t);

  let saveCount = 0;
  const settingsDoc = {
    scope: 'production',
    version: 6,
    updatedAt: new Date('2026-07-09T08:00:00.000Z'),
    draft: baseSettings({ status: 'offline', mode: 'Offline Replay' }),
    published: baseSettings({ status: 'replay', mode: 'Offline Replay' }),
    async save() {
      saveCount += 1;
      return this;
    },
  };
  stubPublicSiteSettings(t, settingsDoc);

  const payload = {
    enabled: true,
    status: 'live',
    mode: 'video',
    provider: 'youtube',
    embedUrl: 'https://www.youtube.com/embed/SLDHOwReM-Q',
    fallbackVideoUrl: 'https://www.youtube.com/watch?v=SLDHOwReM-Q',
    title: 'Live Desk',
    subtitle: 'Breaking updates',
    language: 'en',
    showOnHomepage: false,
    offlinePosterImageUrl: '/uploads/media-library/offline-poster.webp',
    offlineLoopVideoUrl: '/uploads/media-library/offline-loop.webm',
    offlineMessage: 'We will be back shortly.',
    startTime: '2026-07-09T10:00:00.000Z',
    endTime: '2026-07-09T11:00:00.000Z',
    nextLiveTime: '2026-07-10T10:00:00.000Z',
    updatedAt: '2026-07-09T09:30:00.000Z',
  };

  const res = await request(app)
    .patch('/api/admin/live-tv')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send(payload);

  assert.equal(res.status, 200);
  assert.equal(saveCount, 1);
  assert.equal(res.body.liveTv.status, 'live');
  assert.equal(res.body.liveTv.mode, 'video');
  assert.equal(res.body.liveTv.provider, 'youtube');
  assert.equal(res.body.liveTv.language, 'en');
  assert.equal(res.body.liveTv.showOnHomepage, false);
  assert.equal(res.body.liveTv.offlinePosterImageUrl, '/uploads/media-library/offline-poster.webp');
  assert.equal(res.body.liveTv.offlineLoopVideoUrl, '/uploads/media-library/offline-loop.webm');
  assert.equal(res.body.liveTv.offlineMessage, 'We will be back shortly.');
  assert.equal(res.body.liveTv.updatedAt, '2026-07-09T09:30:00.000Z');
  assert.equal(settingsDoc.published.liveTv.status, 'replay');
});

test('POST /api/admin/live-tv/publish publishes only the Live TV settings object', async (t) => {
  stubDbReady(t);

  const settingsDoc = {
    scope: 'production',
    version: 2,
    updatedAt: new Date('2026-07-09T08:00:00.000Z'),
    draft: baseSettings({ status: 'offline', mode: 'Offline Replay' }),
    published: baseSettings({ status: 'replay', mode: 'Offline Replay' }),
    async save() {
      return this;
    },
  };
  stubPublicSiteSettings(t, settingsDoc);

  const res = await request(app)
    .post('/api/admin/live-tv/publish')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({
      liveTv: {
        enabled: true,
        status: 'scheduled',
        mode: 'scheduled-show',
        provider: 'custom',
        title: 'Evening Bulletin',
        startTime: '2026-07-09T18:00:00.000Z',
      },
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.liveTv.status, 'scheduled');
  assert.equal(res.body.published.status, 'scheduled');
  assert.equal(settingsDoc.version, 3);
  assert.equal(settingsDoc.published.liveTv.title, 'Evening Bulletin');
  assert.equal(settingsDoc.published.homepage.modules.liveTvCard.enabled, true);
});

test('POST /api/admin/settings/public/publish can publish a provided Live TV settings object', async (t) => {
  stubDbReady(t);

  const settingsDoc = {
    scope: 'production',
    version: 10,
    updatedAt: new Date('2026-07-09T08:00:00.000Z'),
    draft: baseSettings({ status: 'offline', mode: 'Offline Replay' }),
    published: baseSettings({ status: 'replay', mode: 'Offline Replay' }),
    async save() {
      return this;
    },
  };
  stubPublicSiteSettings(t, settingsDoc);

  const res = await request(app)
    .post('/api/admin/settings/public/publish')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({
      liveTv: {
        enabled: true,
        status: 'live',
        mode: 'video',
        provider: 'youtube',
        embedUrl: 'https://www.youtube.com/embed/SLDHOwReM-Q',
        fallbackVideoUrl: 'https://www.youtube.com/watch?v=SLDHOwReM-Q',
        title: 'Live Now',
        subtitle: 'Public publish payload',
        language: 'en',
        showOnHomepage: true,
        startTime: '2026-07-09T12:00:00.000Z',
        endTime: '2026-07-09T13:00:00.000Z',
        nextLiveTime: '2026-07-10T12:00:00.000Z',
        updatedAt: '2026-07-09T11:55:00.000Z',
      },
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.published.liveTv.status, 'live');
  assert.equal(res.body.published.liveTv.mode, 'video');
  assert.equal(res.body.published.liveTv.provider, 'youtube');
  assert.equal(res.body.published.liveTv.updatedAt, '2026-07-09T11:55:00.000Z');
  assert.equal(settingsDoc.version, 11);
});

test('POST /api/admin/live-tv/deactivate publishes disabled offline Live TV settings', async (t) => {
  stubDbReady(t);

  const settingsDoc = {
    scope: 'production',
    version: 8,
    updatedAt: new Date('2026-07-09T08:00:00.000Z'),
    draft: baseSettings({ enabled: true, status: 'live' }),
    published: baseSettings({ enabled: true, status: 'live' }),
    async save() {
      return this;
    },
  };
  stubPublicSiteSettings(t, settingsDoc);

  const res = await request(app)
    .post('/api/admin/live-tv/deactivate')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ title: 'Paused' });

  assert.equal(res.status, 200);
  assert.equal(res.body.liveTv.enabled, false);
  assert.equal(res.body.liveTv.status, 'offline');
  assert.equal(res.body.published.enabled, false);
  assert.equal(res.body.published.status, 'offline');
  assert.equal(settingsDoc.version, 9);
});