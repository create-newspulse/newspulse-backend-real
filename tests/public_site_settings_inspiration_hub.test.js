const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');

const PublicSiteSettings = require('../models/PublicSiteSettings');
const controller = require('../controllers/publicSiteSettingsController');
const app = require('../server');

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
      },
    },
    tickers: {
      breaking: {
        enabled: true,
        speedSeconds: 30,
      },
      live: {
        enabled: true,
        speedSeconds: 25,
      },
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

test('savePublicSettings stores inspirationHub as isolated derived block', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;
  const prevGetDefaultSettings = PublicSiteSettings.getDefaultSettings;

  mongoose.connection.readyState = 1;

  const draft = baseSettings();
  const published = baseSettings();
  let saveCalls = 0;

  PublicSiteSettings.getDefaultSettings = () => baseSettings();
  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'production',
    version: 1,
    draft,
    published,
    updatedAt: new Date('2026-04-03T08:00:00.000Z'),
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
    body: {
      inspirationHub: {
        enabled: true,
        droneTvEnabled: true,
        youtubeUrl: 'https://www.youtube.com/watch?v=SLDHOwReM-Q',
        title: 'Drone TV',
        subtitle: 'Skyline feed',
        autoplayMuted: true,
        showOnHomepage: true,
        showOnCategoryPage: false,
      },
    },
  };
  const res = createRes();

  await controller.savePublicSettings(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(saveCalls, 1);
  assert.equal(res.body.draft.homepage.modules.categoryStrip.order, 1);
  assert.deepEqual(res.body.published, published);
  assert.deepEqual(res.body.draft.inspirationHub, {
    enabled: true,
    droneTvEnabled: true,
    youtubeUrl: 'https://www.youtube.com/watch?v=SLDHOwReM-Q',
    embedUrl: 'https://www.youtube-nocookie.com/embed/SLDHOwReM-Q?rel=0&autoplay=1&mute=1&playsinline=1',
    title: 'Drone TV',
    subtitle: 'Skyline feed',
    droneTvTitle: '',
    droneTvSubtitle: '',
    dailyWondersTitle: '',
    dailyWondersSubtitle: '',
    narrationText: '',
    autoplayMuted: true,
    showOnHomepage: true,
    showOnCategoryPage: false,
    quotes: [],
    cards: [],
    content: {
      en: {
        title: 'Drone TV',
        subtitle: 'Skyline feed',
      },
      hi: {
        title: 'Drone TV',
        subtitle: 'Skyline feed',
      },
      gu: {
        title: 'Drone TV',
        subtitle: 'Skyline feed',
      },
    },
  });
});

test('savePublicSettings normalizes multilingual inspirationHub content with plain-field fallback', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;
  const prevGetDefaultSettings = PublicSiteSettings.getDefaultSettings;

  mongoose.connection.readyState = 1;

  PublicSiteSettings.getDefaultSettings = () => baseSettings();
  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'production',
    version: 1,
    draft: baseSettings(),
    published: baseSettings(),
    async save() {},
  });

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
    PublicSiteSettings.getDefaultSettings = prevGetDefaultSettings;
  });

  const req = {
    method: 'PATCH',
    body: {
      inspirationHub: {
        enabled: true,
        youtubeUrl: 'https://youtu.be/SLDHOwReM-Q',
        title: 'Inspiration Hub',
        subtitle: 'Daily uplift',
        droneTvTitle: 'DroneTV',
        narrationText: 'English narration fallback',
        quotes: ['Stay curious'],
        content: {
          hi: {
            title: 'प्रेरणा हब',
            subtitle: 'दैनिक प्रेरणा',
            narrationText: 'हिंदी नैरेशन',
          },
          gu: {
            title: 'ઇન્સ્પિરેશન હબ',
            cards: [{ title: 'કાર્ડ 1', body: 'ગુજરાતી' }],
          },
        },
      },
    },
  };
  const res = createRes();

  await controller.savePublicSettings(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.draft.inspirationHub.content.en, {
    title: 'Inspiration Hub',
    subtitle: 'Daily uplift',
    droneTvTitle: 'DroneTV',
    narrationText: 'English narration fallback',
    quotes: ['Stay curious'],
  });
  assert.deepEqual(res.body.draft.inspirationHub.content.hi, {
    title: 'प्रेरणा हब',
    subtitle: 'दैनिक प्रेरणा',
    droneTvTitle: 'DroneTV',
    narrationText: 'हिंदी नैरेशन',
    quotes: ['Stay curious'],
  });
  assert.deepEqual(res.body.draft.inspirationHub.content.gu, {
    title: 'ઇન્સ્પિરેશન હબ',
    subtitle: 'Daily uplift',
    droneTvTitle: 'DroneTV',
    narrationText: 'English narration fallback',
    quotes: ['Stay curious'],
    cards: [{ title: 'કાર્ડ 1', body: 'ગુજરાતી' }],
  });
});

test('publishSettings copies normalized inspirationHub into published response', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;

  let saveCalls = 0;
  const settingsDoc = {
    scope: 'production',
    version: 7,
    draft: {
      ...baseSettings(),
      inspirationHub: {
        enabled: true,
        droneTvEnabled: true,
        youtubeUrl: 'https://youtu.be/SLDHOwReM-Q',
        title: 'Drone TV',
        subtitle: 'Skyline feed',
        autoplayMuted: false,
        showOnHomepage: true,
        showOnCategoryPage: true,
      },
    },
    published: baseSettings(),
    updatedAt: new Date('2026-04-03T08:00:00.000Z'),
    publishedUpdatedAt: new Date('2026-04-03T08:00:00.000Z'),
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
  assert.deepEqual(res.body.published.inspirationHub, {
    enabled: true,
    droneTvEnabled: true,
    youtubeUrl: 'https://youtu.be/SLDHOwReM-Q',
    embedUrl: 'https://www.youtube-nocookie.com/embed/SLDHOwReM-Q?rel=0',
    title: 'Drone TV',
    subtitle: 'Skyline feed',
    droneTvTitle: '',
    droneTvSubtitle: '',
    dailyWondersTitle: '',
    dailyWondersSubtitle: '',
    narrationText: '',
    autoplayMuted: false,
    showOnHomepage: true,
    showOnCategoryPage: true,
    quotes: [],
    cards: [],
    content: {
      en: {
        title: 'Drone TV',
        subtitle: 'Skyline feed',
      },
      hi: {
        title: 'Drone TV',
        subtitle: 'Skyline feed',
      },
      gu: {
        title: 'Drone TV',
        subtitle: 'Skyline feed',
      },
    },
  });
});

test('savePublicSettings rejects invalid inspirationHub youtube URLs', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;

  let saveCalls = 0;
  PublicSiteSettings.getOrCreate = async () => ({
    draft: baseSettings(),
    published: baseSettings(),
    async save() {
      saveCalls += 1;
    },
  });

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const req = {
    method: 'PATCH',
    body: {
      inspirationHub: {
        youtubeUrl: 'https://example.com/not-youtube',
      },
    },
  };
  const res = createRes();

  await controller.savePublicSettings(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(saveCalls, 0);
  assert.match(String(res.body.message || ''), /inspirationHub\.youtubeUrl/i);
});

test('savePublicSettings allows removing the optional inspirationHub block', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;

  const draft = {
    ...baseSettings(),
    inspirationHub: {
      enabled: true,
      droneTvEnabled: true,
      youtubeUrl: 'https://youtu.be/SLDHOwReM-Q',
      embedUrl: 'https://www.youtube-nocookie.com/embed/SLDHOwReM-Q?rel=0',
      title: 'Drone TV',
      subtitle: 'Skyline feed',
      autoplayMuted: false,
      showOnHomepage: true,
      showOnCategoryPage: true,
    },
  };

  let saveCalls = 0;
  PublicSiteSettings.getOrCreate = async () => ({
    draft,
    published: baseSettings(),
    async save() {
      saveCalls += 1;
    },
  });

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const req = {
    method: 'PATCH',
    body: {
      inspirationHub: null,
    },
  };
  const res = createRes();

  await controller.savePublicSettings(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(saveCalls, 1);
  assert.equal('inspirationHub' in res.body.draft, false);
  assert.equal(res.body.draft.liveTv.enabled, true);
});

test('getPublishedSettings leaves legacy public settings unchanged when inspirationHub is absent', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;

  const published = baseSettings();
  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'production',
    version: 3,
    published,
    publishedUpdatedAt: new Date('2026-04-03T09:00:00.000Z'),
    updatedAt: new Date('2026-04-03T08:00:00.000Z'),
  });

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const res = createRes();
  await controller.getPublishedSettings({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.version, 3);
  assert.equal('inspirationHub' in res.body.published, false);
  assert.equal(res.body.published.liveTv.enabled, true);
});

test('legacy public settings alias returns normalized published inspirationHub embedUrl', async (t) => {
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  PublicSiteSettings.getOrCreate = async () => ({
    version: 9,
    published: {
      ...baseSettings(),
      inspirationHub: {
        enabled: true,
        droneTvEnabled: true,
        youtubeUrl: 'https://www.youtube.com/watch?v=SLDHOwReM-Q',
        title: 'Drone TV',
        subtitle: 'Skyline feed',
        narrationText: 'Fallback narration',
        autoplayMuted: true,
        showOnHomepage: true,
        showOnCategoryPage: false,
        content: {
          hi: {
            title: 'ड्रोन टीवी',
          },
        },
      },
    },
    publishedUpdatedAt: new Date('2026-04-03T09:30:00.000Z'),
    updatedAt: new Date('2026-04-03T08:00:00.000Z'),
  });

  t.after(() => {
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const res = await request(app).get('/api/settings/public');

  assert.equal(res.status, 200);
  assert.equal(res.body.version, 9);
  assert.equal(res.body.updatedAt, '2026-04-03T09:30:00.000Z');
  assert.equal(res.body.published.inspirationHub.youtubeUrl, 'https://www.youtube.com/watch?v=SLDHOwReM-Q');
  assert.equal(
    res.body.published.inspirationHub.embedUrl,
    'https://www.youtube-nocookie.com/embed/SLDHOwReM-Q?rel=0&autoplay=1&mute=1&playsinline=1'
  );
  assert.equal(res.body.published.inspirationHub.content.en.title, 'Drone TV');
  assert.equal(res.body.published.inspirationHub.content.hi.title, 'ड्रोन टीवी');
  assert.equal(res.body.published.inspirationHub.content.hi.narrationText, 'Fallback narration');
  assert.equal(res.body.public.inspirationHub.embedUrl, res.body.published.inspirationHub.embedUrl);
});

test('savePublicSettings rejects invalid multilingual inspirationHub content types', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;

  PublicSiteSettings.getOrCreate = async () => ({
    draft: baseSettings(),
    published: baseSettings(),
    async save() {},
  });

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const req = {
    method: 'PATCH',
    body: {
      inspirationHub: {
        content: {
          hi: {
            quotes: 'not-an-array',
          },
        },
      },
    },
  };
  const res = createRes();

  await controller.savePublicSettings(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(String(res.body.message || ''), /inspirationHub\.content\.hi\.quotes/i);
});
