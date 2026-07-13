const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const AiraBulletin = require('../models/AiraBulletin');
const PublicSiteSettings = require('../models/PublicSiteSettings');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function makeBulletin(data = {}) {
  const doc = {
    _id: data._id || new mongoose.Types.ObjectId(),
    title: '',
    language: 'English',
    bulletinType: 'Morning',
    durationMinutes: 5,
    scheduleDate: '',
    scheduleTime: '',
    endTime: '',
    publicLabel: 'AIRA BULLETIN',
    anchorName: '',
    anchorFace: '',
    dressStyle: '',
    voiceStyle: '',
    tone: '',
    studioTemplate: '',
    script: '',
    audioUrl: '',
    videoUrl: '',
    visualBlocks: [],
    status: 'Draft',
    publishStatus: '',
    liveTvAssociation: null,
    createdBy: '',
    updatedBy: '',
    createdAt: data.createdAt || new Date('2026-07-13T10:00:00.000Z'),
    updatedAt: data.updatedAt || new Date('2026-07-13T10:00:00.000Z'),
    ...data,
    async save() {
      this.updatedAt = new Date('2026-07-13T10:15:00.000Z');
      return this;
    },
    toObject() {
      const { save, toObject, ...plain } = this;
      return plain;
    },
  };
  return doc;
}

function stubDbReady(t) {
  const prevReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
  });
}

function stubAiraBulletins(t, store) {
  const prevCreate = AiraBulletin.create;
  const prevFind = AiraBulletin.find;
  const prevFindById = AiraBulletin.findById;
  const prevFindByIdAndUpdate = AiraBulletin.findByIdAndUpdate;

  AiraBulletin.create = async (payload) => {
    const doc = makeBulletin({ ...payload, createdAt: new Date(Date.now()) });
    store.set(String(doc._id), doc);
    return doc;
  };
  AiraBulletin.find = (filter = {}) => ({
    sort() { return this; },
    async lean() {
      return Array.from(store.values())
        .filter((doc) => {
          if (filter.status && doc.status !== filter.status) return false;
          if (filter.videoUrl && filter.videoUrl.$ne === '' && !doc.videoUrl) return false;
          return true;
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .map((doc) => doc.toObject());
    },
  });
  AiraBulletin.findById = async (id) => store.get(String(id)) || null;
  AiraBulletin.findByIdAndUpdate = async (id, update) => {
    const doc = store.get(String(id));
    if (!doc) return null;
    Object.assign(doc, update && update.$set ? update.$set : update);
    return doc;
  };

  t.after(() => {
    AiraBulletin.create = prevCreate;
    AiraBulletin.find = prevFind;
    AiraBulletin.findById = prevFindById;
    AiraBulletin.findByIdAndUpdate = prevFindByIdAndUpdate;
  });
}

function baseSettings(liveTv = {}) {
  return {
    publicSite: { homepage: { categoryStripEnabled: true } },
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
    languageTheme: { languages: ['en', 'hi', 'gu'], themePreset: 'default' },
  };
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

test('GET /api/aira/status returns local workflow ready status', async () => {
  const res = await request(app).get('/api/aira/status');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    enabled: true,
    phase: 'local-workflow-ready',
    displayStatus: 'AIRA Studio Ready',
    storageMode: 'local-test-mode',
    serverTtsConfigured: false,
    aiVideoProviderConfigured: false,
    manualVideoUrlEnabled: true,
    liveTvPublishConfigured: true,
    scheduleConfigured: true,
    message: 'AIRA manual bulletin workflow, approval, schedule metadata, and Live TV publishing are available in local testing mode.',
  });
});

test('AIRA manual bulletin CRUD supports create, update, list, get, and transitions', async (t) => {
  stubDbReady(t);
  const store = new Map();
  stubAiraBulletins(t, store);
  const token = makeOpaqueAdminToken();

  const createRes = await request(app)
    .post('/api/aira/bulletins')
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: 'Morning Manual Bulletin',
      language: 'Gujarati',
      bulletinType: 'Morning',
      durationMinutes: 5,
      scheduleDate: '2026-07-14',
      scheduleTime: '08:00',
      endTime: '08:05',
      publicLabel: 'AIRA BULLETIN',
      anchorName: 'AIRA Anchor',
      anchorFace: 'default',
      dressStyle: 'formal',
      voiceStyle: 'calm',
      tone: 'newsroom',
      studioTemplate: 'studio-a',
      script: 'Good morning. These are the top updates.',
      videoUrl: 'https://cdn.example.com/aira/manual.mp4',
      visualBlocks: [{
        id: 'block-1',
        startTime: '00:00',
        endTime: '00:10',
        visualType: 'headline_card',
        title: 'Top Story',
        description: 'Lead update',
        sourceCredit: 'News Pulse',
        mediaUrl: 'https://cdn.example.com/aira/card.jpg',
      }],
    });

  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.bulletin.title, 'Morning Manual Bulletin');
  assert.equal(createRes.body.bulletin.status, 'Draft');
  assert.equal(createRes.body.bulletin.videoUrl, 'https://cdn.example.com/aira/manual.mp4');
  assert.equal(createRes.body.bulletin.visualBlocks[0].visualType, 'headline_card');

  const id = createRes.body.bulletin.id;

  const updateRes = await request(app)
    .patch(`/api/aira/bulletins/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ durationMinutes: 10, publicLabel: 'SCHEDULED', audioUrl: 'https://cdn.example.com/aira/manual.mp3' });

  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.bulletin.durationMinutes, 10);
  assert.equal(updateRes.body.bulletin.publicLabel, 'SCHEDULED');
  assert.equal(updateRes.body.bulletin.audioUrl, 'https://cdn.example.com/aira/manual.mp3');

  const listRes = await request(app)
    .get('/api/aira/bulletins')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.bulletins.length, 1);
  assert.equal(listRes.body.bulletins[0].id, id);

  const getRes = await request(app)
    .get(`/api/aira/bulletins/${id}`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.bulletin.id, id);

  const readyRes = await request(app).post(`/api/aira/bulletins/${id}/ready-for-review`).set('Authorization', `Bearer ${token}`).send({});
  assert.equal(readyRes.status, 200);
  assert.equal(readyRes.body.bulletin.status, 'Ready for Review');

  const approveRes = await request(app).post(`/api/aira/bulletins/${id}/approve`).set('Authorization', `Bearer ${token}`).send({});
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.body.bulletin.status, 'Approved');

  const rejectRes = await request(app).post(`/api/aira/bulletins/${id}/reject`).set('Authorization', `Bearer ${token}`).send({});
  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.body.bulletin.status, 'Rejected');

  const archiveRes = await request(app).post(`/api/aira/bulletins/${id}/archive`).set('Authorization', `Bearer ${token}`).send({});
  assert.equal(archiveRes.status, 200);
  assert.equal(archiveRes.body.bulletin.status, 'Archived');
});

test('AIRA manual bulletin validation returns clear 400 and 404 responses', async (t) => {
  stubDbReady(t);
  const store = new Map();
  stubAiraBulletins(t, store);
  const token = makeOpaqueAdminToken();

  const missingTitle = await request(app)
    .post('/api/aira/bulletins')
    .set('Authorization', `Bearer ${token}`)
    .send({ language: 'English' });

  assert.equal(missingTitle.status, 400);
  assert.match(missingTitle.body.message, /title is required/);

  const invalidLanguage = await request(app)
    .post('/api/aira/bulletins')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Invalid Language', language: 'Marathi' });

  assert.equal(invalidLanguage.status, 400);
  assert.match(invalidLanguage.body.message, /language must be one of/);

  const invalidVisualType = await request(app)
    .post('/api/aira/bulletins')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Invalid Visual', language: 'English', visualBlocks: [{ visualType: 'chart' }] });

  assert.equal(invalidVisualType.status, 400);
  assert.match(invalidVisualType.body.message, /visualBlocks\[0\]\.visualType/);

  const notFound = await request(app)
    .get(`/api/aira/bulletins/${new mongoose.Types.ObjectId()}`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.code, 'AIRA_BULLETIN_NOT_FOUND');
});

test('AIRA provider endpoints return clean not-configured messages', async () => {
  const id = new mongoose.Types.ObjectId();
  const voiceRes = await request(app).post(`/api/aira/bulletins/${id}/generate-voice`).send({});
  const videoRes = await request(app).post(`/api/aira/bulletins/${id}/generate-video`).send({});

  assert.equal(voiceRes.status, 200);
  assert.equal(voiceRes.body.code, 'SERVER_TTS_NOT_CONFIGURED');
  assert.equal(voiceRes.body.message, 'SERVER_TTS_NOT_CONFIGURED');
  assert.equal(videoRes.status, 200);
  assert.equal(videoRes.body.code, 'AI_VIDEO_PROVIDER_NOT_CONFIGURED');
  assert.equal(videoRes.body.message, 'AI_VIDEO_PROVIDER_NOT_CONFIGURED');
});

test('AIRA approved bulletin publishes to existing Live TV settings and current source', async (t) => {
  stubDbReady(t);
  const id = new mongoose.Types.ObjectId();
  const store = new Map([[String(id), makeBulletin({
    _id: id,
    title: 'Prime Time AIRA',
    language: 'Hindi',
    bulletinType: 'Prime Time',
    script: 'Tonight on News Pulse.',
    videoUrl: 'https://www.youtube.com/watch?v=SLDHOwReM-Q',
    status: 'Approved',
  })]]);
  stubAiraBulletins(t, store);

  let saveCount = 0;
  const settingsDoc = {
    scope: 'production',
    version: 4,
    draft: baseSettings({ status: 'replay', mode: 'Offline Replay' }),
    published: baseSettings({ status: 'replay', mode: 'Offline Replay' }),
    async save() {
      saveCount += 1;
      return this;
    },
  };
  stubPublicSiteSettings(t, settingsDoc);

  const res = await request(app)
    .post(`/api/aira/bulletins/${id}/publish-to-live-tv`)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ label: 'AIRA BULLETIN • ON AIR', startTime: null, endTime: null });

  assert.equal(res.status, 200);
  assert.equal(saveCount, 1);
  assert.equal(res.body.bulletin.publishStatus, 'Published');
  assert.equal(res.body.liveTv.mode, 'AIRA Bulletin');
  assert.equal(res.body.liveTv.provider, 'YouTube');
  assert.equal(res.body.liveTv.embedUrl, 'https://www.youtube.com/embed/SLDHOwReM-Q');
  assert.equal(res.body.liveTv.fallbackVideoUrl, 'https://www.youtube.com/watch?v=SLDHOwReM-Q');
  assert.equal(res.body.liveTv.sourceType, 'aira_bulletin');
  assert.equal(res.body.liveTv.airaBulletinId, String(id));
  assert.equal(res.body.liveTv.currentProgramLabel, 'AIRA BULLETIN • ON AIR');
  assert.equal(settingsDoc.published.liveTv.title, 'Prime Time AIRA');
  assert.equal(settingsDoc.published.homepage.modules.liveTvCard.enabled, true);

  const currentSource = await request(app).get('/api/live-tv/current-source');
  assert.equal(currentSource.status, 200);
  assert.equal(currentSource.body.enabled, true);
  assert.equal(currentSource.body.sourceType, 'aira_bulletin');
  assert.equal(currentSource.body.title, 'Prime Time AIRA');
  assert.equal(currentSource.body.subtitle, 'Prime Time • Hindi');
  assert.equal(currentSource.body.label, 'AIRA BULLETIN • ON AIR');
  assert.equal(currentSource.body.provider, 'youtube');
  assert.equal(currentSource.body.embedUrl, 'https://www.youtube.com/embed/SLDHOwReM-Q');
  assert.equal(currentSource.body.currentProgramTitle, 'Prime Time AIRA');
  assert.equal(currentSource.body.currentProgramLabel, 'AIRA BULLETIN • ON AIR');
  assert.equal(currentSource.body.showOnHomepage, true);
  assert.equal(currentSource.body.status, 'on_air');
});

test('AIRA Live TV publish validates approval and playable video', async (t) => {
  stubDbReady(t);
  const draftId = new mongoose.Types.ObjectId();
  const noVideoId = new mongoose.Types.ObjectId();
  const store = new Map([
    [String(draftId), makeBulletin({ _id: draftId, title: 'Draft', language: 'English', status: 'Draft', videoUrl: 'https://cdn.example.com/draft.mp4' })],
    [String(noVideoId), makeBulletin({ _id: noVideoId, title: 'No Video', language: 'English', status: 'Approved', videoUrl: '' })],
  ]);
  stubAiraBulletins(t, store);

  const token = makeOpaqueAdminToken();
  const notApproved = await request(app).post(`/api/aira/bulletins/${draftId}/publish-to-live-tv`).set('Authorization', `Bearer ${token}`).send({});
  assert.equal(notApproved.status, 409);
  assert.equal(notApproved.body.code, 'AIRA_BULLETIN_NOT_APPROVED');

  const noVideo = await request(app).post(`/api/aira/bulletins/${noVideoId}/publish-to-live-tv`).set('Authorization', `Bearer ${token}`).send({});
  assert.equal(noVideo.status, 400);
  assert.equal(noVideo.body.code, 'AIRA_BULLETIN_VIDEO_REQUIRED');

  const notFound = await request(app).post(`/api/aira/bulletins/${new mongoose.Types.ObjectId()}/publish-to-live-tv`).set('Authorization', `Bearer ${token}`).send({});
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.code, 'AIRA_BULLETIN_NOT_FOUND');
});

test('AIRA approved bulletins can be scheduled, replayed, listed, and removed from Live TV metadata', async (t) => {
  stubDbReady(t);
  const id = new mongoose.Types.ObjectId();
  const archivedId = new mongoose.Types.ObjectId();
  const store = new Map([
    [String(id), makeBulletin({ _id: id, title: 'Evening AIRA', language: 'English', bulletinType: 'Evening', script: 'Evening bulletin.', videoUrl: 'https://cdn.example.com/evening.mp4', status: 'Approved' })],
    [String(archivedId), makeBulletin({ _id: archivedId, title: 'Archived AIRA', language: 'English', videoUrl: 'https://cdn.example.com/archived.mp4', status: 'Archived' })],
  ]);
  stubAiraBulletins(t, store);

  const settingsDoc = {
    scope: 'production',
    version: 1,
    draft: baseSettings({ status: 'replay', mode: 'Offline Replay' }),
    published: baseSettings({ status: 'replay', mode: 'Offline Replay' }),
    async save() { return this; },
  };
  stubPublicSiteSettings(t, settingsDoc);
  const token = makeOpaqueAdminToken();

  const ready = await request(app).get('/api/aira/bulletins/approved/live-tv-ready').set('Authorization', `Bearer ${token}`);
  assert.equal(ready.status, 200);
  assert.equal(ready.body.bulletins.length, 1);
  assert.equal(ready.body.bulletins[0].id, String(id));

  const schedule = await request(app)
    .post(`/api/aira/bulletins/${id}/schedule-live-tv`)
    .set('Authorization', `Bearer ${token}`)
    .send({ scheduleDate: '2026-07-14', startTime: '19:00', endTime: '19:10', label: 'SCHEDULED' });
  assert.equal(schedule.status, 200);
  assert.equal(schedule.body.bulletin.publishStatus, 'Scheduled');
  assert.equal(schedule.body.liveTv.scheduledPrograms.length, 1);
  assert.equal(schedule.body.liveTv.scheduledPrograms[0].airaBulletinId, String(id));

  const replay = await request(app).post(`/api/aira/bulletins/${id}/set-as-replay`).set('Authorization', `Bearer ${token}`).send({});
  assert.equal(replay.status, 200);
  assert.equal(replay.body.liveTv.mode, 'Offline Replay');
  assert.equal(replay.body.liveTv.status, 'replay');
  assert.equal(replay.body.liveTv.sourceType, 'offline_replay');
  assert.equal(replay.body.liveTv.fallbackVideoUrl, 'https://cdn.example.com/evening.mp4');

  const remove = await request(app).post(`/api/aira/bulletins/${id}/remove-from-live-tv`).set('Authorization', `Bearer ${token}`).send({});
  assert.equal(remove.status, 200);
  assert.equal(remove.body.bulletin.publishStatus, '');
  assert.equal(remove.body.liveTv.airaBulletinId, '');
  assert.equal(remove.body.liveTv.scheduledPrograms.length, 0);
});

function localDateText(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localTimeText(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

test('GET /api/live-tv/current-source returns MP4 source with video provider and stable fields', async (t) => {
  stubDbReady(t);
  stubPublicSiteSettings(t, {
    scope: 'production',
    version: 1,
    draft: baseSettings(),
    published: baseSettings({
      enabled: true,
      status: 'live',
      sourceType: 'aira_bulletin',
      title: 'AIRA International Update',
      subtitle: 'Gujarati bulletin',
      provider: 'Custom Embed',
      embedUrl: '',
      fallbackVideoUrl: 'https://cdn.example.com/live/aira.mp4',
      currentVideoUrl: 'https://cdn.example.com/live/aira.mp4',
      currentProgramTitle: 'AIRA International Update',
      currentProgramLabel: 'AIRA BULLETIN • ON AIR',
      offlinePosterImageUrl: '/uploads/media-library/current-poster.webp',
      offlineLoopVideoUrl: '/uploads/media-library/current-loop.webm',
      offlineMessage: 'Offline current source message',
      showOnHomepage: true,
      updatedAt: '2026-07-13T10:00:00.000Z',
    }),
    async save() { return this; },
  });

  const res = await request(app).get('/api/live-tv/current-source');

  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.sourceType, 'aira_bulletin');
  assert.equal(res.body.title, 'AIRA International Update');
  assert.equal(res.body.subtitle, 'Gujarati bulletin');
  assert.equal(res.body.label, 'AIRA BULLETIN • ON AIR');
  assert.equal(res.body.status, 'on_air');
  assert.equal(res.body.provider, 'video');
  assert.equal(res.body.embedUrl, '');
  assert.equal(res.body.fallbackVideoUrl, 'https://cdn.example.com/live/aira.mp4');
  assert.equal(res.body.currentVideoUrl, 'https://cdn.example.com/live/aira.mp4');
  assert.equal(res.body.currentProgramTitle, 'AIRA International Update');
  assert.equal(res.body.currentProgramLabel, 'AIRA BULLETIN • ON AIR');
  assert.equal(res.body.offlinePosterImageUrl, '/uploads/media-library/current-poster.webp');
  assert.equal(res.body.offlineLoopVideoUrl, '/uploads/media-library/current-loop.webm');
  assert.equal(res.body.offlineMessage, 'Offline current source message');
  assert.equal(res.body.showOnHomepage, true);
  assert.equal(res.body.updatedAt, '2026-07-13T10:00:00.000Z');
});

test('GET /api/live-tv/current-source applies priority for breaking over scheduled and replay', async (t) => {
  stubDbReady(t);
  const now = new Date();
  const scheduleDate = localDateText(now);
  const startTime = localTimeText(new Date(now.getTime() - 5 * 60 * 1000));
  const endTime = localTimeText(new Date(now.getTime() + 30 * 60 * 1000));
  stubPublicSiteSettings(t, {
    scope: 'production',
    version: 1,
    draft: baseSettings(),
    published: baseSettings({
      enabled: true,
      status: 'live',
      sourceType: 'breaking_bulletin',
      title: 'Breaking Live',
      subtitle: 'Urgent update',
      fallbackVideoUrl: 'https://cdn.example.com/live/breaking.mp4',
      currentProgramLabel: 'BREAKING BULLETIN',
      scheduledPrograms: [{
        airaBulletinId: 'scheduled-1',
        title: 'Scheduled AIRA',
        label: 'SCHEDULED',
        bulletinType: 'Evening',
        language: 'English',
        scheduleDate,
        startTime,
        endTime,
        videoUrl: 'https://cdn.example.com/live/scheduled.mp4',
        fallbackVideoUrl: 'https://cdn.example.com/live/scheduled.mp4',
      }],
    }),
    async save() { return this; },
  });

  const res = await request(app).get('/api/live-tv/current-source');

  assert.equal(res.status, 200);
  assert.equal(res.body.sourceType, 'breaking_bulletin');
  assert.equal(res.body.label, 'BREAKING BULLETIN');
  assert.equal(res.body.title, 'Breaking Live');
  assert.equal(res.body.currentVideoUrl, 'https://cdn.example.com/live/breaking.mp4');
});

test('GET /api/live-tv/current-source selects scheduled source inside current time window', async (t) => {
  stubDbReady(t);
  const now = new Date();
  const scheduleDate = localDateText(now);
  const startTime = localTimeText(new Date(now.getTime() - 5 * 60 * 1000));
  const endTime = localTimeText(new Date(now.getTime() + 30 * 60 * 1000));
  stubPublicSiteSettings(t, {
    scope: 'production',
    version: 1,
    draft: baseSettings(),
    published: baseSettings({
      enabled: true,
      status: 'replay',
      sourceType: 'offline_replay',
      title: 'Replay Program',
      fallbackVideoUrl: 'https://cdn.example.com/live/replay.mp4',
      scheduledPrograms: [{
        airaBulletinId: 'scheduled-2',
        title: 'Scheduled AIRA',
        label: 'SCHEDULED',
        bulletinType: 'Noon',
        language: 'Gujarati',
        scheduleDate,
        startTime,
        endTime,
        videoUrl: 'https://youtu.be/SLDHOwReM-Q',
        fallbackVideoUrl: 'https://youtu.be/SLDHOwReM-Q',
      }],
    }),
    async save() { return this; },
  });

  const res = await request(app).get('/api/live-tv/current-source');

  assert.equal(res.status, 200);
  assert.equal(res.body.sourceType, 'scheduled_program');
  assert.equal(res.body.label, 'SCHEDULED');
  assert.equal(res.body.title, 'Scheduled AIRA');
  assert.equal(res.body.subtitle, 'Noon • Gujarati');
  assert.equal(res.body.provider, 'youtube');
  assert.equal(res.body.embedUrl, 'https://www.youtube.com/embed/SLDHOwReM-Q');
  assert.equal(res.body.status, 'scheduled');
});

test('GET /api/live-tv/current-source returns maintenance fallback when active video is missing', async (t) => {
  stubDbReady(t);
  stubPublicSiteSettings(t, {
    scope: 'production',
    version: 1,
    draft: baseSettings(),
    published: baseSettings({
      enabled: true,
      status: 'live',
      sourceType: 'aira_bulletin',
      title: 'Broken Live Source',
      embedUrl: '',
      fallbackVideoUrl: '',
      currentVideoUrl: '',
      offlinePosterImageUrl: '/uploads/media-library/fallback-poster.webp',
      offlineLoopVideoUrl: '/uploads/media-library/fallback-loop.webm',
      offlineMessage: 'Fallback offline message',
    }),
    async save() { return this; },
  });

  const res = await request(app).get('/api/live-tv/current-source');

  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.sourceType, 'maintenance');
  assert.equal(res.body.label, 'COMING SOON');
  assert.equal(res.body.status, 'maintenance');
  assert.equal(res.body.message, 'Live TV video is not available right now.');
  assert.equal(res.body.offlinePosterImageUrl, '/uploads/media-library/fallback-poster.webp');
  assert.equal(res.body.offlineLoopVideoUrl, '/uploads/media-library/fallback-loop.webm');
  assert.equal(res.body.offlineMessage, 'Fallback offline message');
});