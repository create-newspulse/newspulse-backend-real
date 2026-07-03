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
      mode: 'Offline Replay',
      provider: 'YouTube',
      embedUrl: '',
      fallbackVideoUrl: '',
      title: 'News Pulse Live',
      subtitle: '',
      language: 'English',
      showOnHomepage: true,
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
    showOnInspirationHubPage: false,
    showOnCategoryPage: false,
    videoTitle: 'Drone TV',
    videoSubtitle: 'Skyline feed',
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
    showOnInspirationHubPage: true,
    showOnCategoryPage: true,
    videoTitle: 'Drone TV',
    videoSubtitle: 'Skyline feed',
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

test('getPublishedSettings maps legacy DroneTV homepage aliases into canonical visible settings', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;

  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'production',
    version: 11,
    published: {
      ...baseSettings(),
      inspirationHub: {
        enableInspirationHub: true,
        enableDroneTVVideo: true,
        homepageEnabled: true,
        droneTvYoutubeUrl: 'https://youtu.be/SLDHOwReM-Q',
        videoTitle: 'Admin DroneTV Title',
        videoSubtitle: 'Admin DroneTV Subtitle',
      },
    },
    publishedUpdatedAt: new Date('2026-04-29T10:00:00.000Z'),
  });

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const res = createRes();
  await controller.getPublishedSettings({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.published.inspirationHub.enabled, true);
  assert.equal(res.body.published.inspirationHub.droneTvEnabled, true);
  assert.equal(res.body.published.inspirationHub.showOnHomepage, true);
  assert.equal(res.body.published.inspirationHub.youtubeUrl, 'https://youtu.be/SLDHOwReM-Q');
  assert.equal(res.body.published.inspirationHub.embedUrl, 'https://www.youtube-nocookie.com/embed/SLDHOwReM-Q?rel=0');
  assert.equal(res.body.published.inspirationHub.title, 'Admin DroneTV Title');
  assert.equal(res.body.published.inspirationHub.subtitle, 'Admin DroneTV Subtitle');
  assert.equal(res.body.published.inspirationHub.videoTitle, 'Admin DroneTV Title');
  assert.equal(res.body.published.inspirationHub.videoSubtitle, 'Admin DroneTV Subtitle');
  assert.equal(res.body.published.inspirationHub.showOnInspirationHubPage, false);
});

test('getPublishedSettings keeps Inspiration Hub hidden when explicit enabled is false', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;

  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'production',
    version: 12,
    published: {
      ...baseSettings(),
      inspirationHub: {
        enabled: false,
        enableInspirationHub: true,
        droneTvEnabled: true,
        showOnHomepage: true,
        embedUrl: 'https://www.youtube-nocookie.com/embed/SLDHOwReM-Q?rel=0',
      },
    },
    publishedUpdatedAt: new Date('2026-04-29T10:05:00.000Z'),
  });

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const res = createRes();
  await controller.getPublishedSettings({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.published.inspirationHub.enabled, false);
  assert.equal(res.body.published.inspirationHub.droneTvEnabled, true);
  assert.equal(res.body.published.inspirationHub.showOnHomepage, true);
  assert.equal(res.body.published.inspirationHub.embedUrl, 'https://www.youtube-nocookie.com/embed/SLDHOwReM-Q?rel=0');
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

test('getPublishedSettings adds disabled public inspirationHub contract when absent', async (t) => {
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
  assert.equal(res.body.published.inspirationHub.enabled, false);
  assert.equal(res.body.published.inspirationHub.droneTvEnabled, false);
  assert.equal(res.body.published.inspirationHub.showOnHomepage, false);
  assert.equal(res.body.published.inspirationHub.showOnInspirationHubPage, false);
  assert.equal(res.body.published.inspirationHub.autoplayMuted, false);
  assert.equal(res.body.published.inspirationHub.youtubeUrl, '');
  assert.equal(res.body.published.inspirationHub.embedUrl, '');
  assert.equal(res.body.published.inspirationHub.videoTitle, 'Inspiration Hub');
  assert.equal(res.body.published.inspirationHub.videoSubtitle, 'A calm space for perspective, clarity, and meaningful stories.');
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

test('getPublishedSettings normalizes liveTv defaults when config is empty', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;

  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'production',
    version: 13,
    published: {
      ...baseSettings(),
      liveTv: {},
    },
    publishedUpdatedAt: new Date('2026-07-03T09:30:00.000Z'),
    updatedAt: new Date('2026-07-03T09:00:00.000Z'),
  });

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    PublicSiteSettings.getOrCreate = prevGetOrCreate;
  });

  const res = createRes();
  await controller.getPublishedSettings({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.published.liveTv.enabled, true);
  assert.equal(res.body.published.liveTv.mode, 'Offline Replay');
  assert.equal(res.body.published.liveTv.provider, 'YouTube');
  assert.equal(res.body.published.liveTv.fallbackVideoUrl, '');
  assert.equal(res.body.published.liveTv.title, 'News Pulse Live');
  assert.equal(res.body.published.liveTv.language, 'English');
  assert.equal(res.body.published.liveTv.showOnHomepage, true);
});

test('savePublicSettings validates and persists liveTv settings', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevGetOrCreate = PublicSiteSettings.getOrCreate;

  mongoose.connection.readyState = 1;

  const draft = baseSettings();
  const published = baseSettings();
  let saveCalls = 0;

  PublicSiteSettings.getOrCreate = async () => ({
    scope: 'production',
    version: 1,
    draft,
    published,
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
      liveTv: {
        enabled: false,
        mode: 'Breaking Mode',
        provider: 'Custom Embed',
        embedUrl: 'https://player.example.com/embed/live',
        fallbackVideoUrl: 'https://cdn.example.com/fallback.mp4',
        title: 'Breaking Live',
        subtitle: 'Emergency coverage',
        language: 'Hindi',
        showOnHomepage: false,
      },
    },
  };
  const res = createRes();

  await controller.savePublicSettings(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(saveCalls, 1);
  assert.deepEqual(res.body.draft.liveTv, {
    enabled: false,
    mode: 'Breaking Mode',
    provider: 'Custom Embed',
    embedUrl: 'https://player.example.com/embed/live',
    fallbackVideoUrl: 'https://cdn.example.com/fallback.mp4',
    title: 'Breaking Live',
    subtitle: 'Emergency coverage',
    language: 'Hindi',
    showOnHomepage: false,
  });
});

test('savePublicSettings rejects invalid liveTv mode/provider/language values', async (t) => {
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
      liveTv: {
        mode: 'Media Partner Live',
      },
    },
  };
  const res = createRes();

  await controller.savePublicSettings(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(saveCalls, 0);
  assert.match(String(res.body.message || ''), /liveTv\.mode/i);
});
