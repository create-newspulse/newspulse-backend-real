const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const AiraBulletin = require('../models/AiraBulletin');
const LiveTvSchedule = require('../models/LiveTvSchedule');
const PublicSiteSettings = require('../models/PublicSiteSettings');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function baseSettings(liveTv = {}) {
  return {
    publicSite: { homepage: { categoryStripEnabled: true } },
    homepage: { modules: { categoryStrip: { enabled: true, order: 1 }, trendingStrip: { enabled: true, order: 2 }, exploreCategories: { enabled: true, order: 3 }, liveTvCard: { enabled: true, order: 4 } } },
    tickers: { breaking: { enabled: true, speedSeconds: 30 }, live: { enabled: true, speedSeconds: 25 } },
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

function makeSchedule(data = {}) {
  const doc = {
    _id: data._id || new mongoose.Types.ObjectId(),
    programTitle: 'Live Program',
    sourceType: 'youtube_live',
    label: 'LIVE',
    date: '2026-07-13',
    startTime: '10:00',
    endTime: '10:30',
    durationMinutes: null,
    selectedAiraBulletinId: '',
    videoUrl: '',
    embedUrl: '',
    sponsorName: '',
    sponsorLabel: '',
    status: 'scheduled',
    priority: 'normal',
    repeat: 'none',
    createdBy: '',
    updatedBy: '',
    createdAt: new Date('2026-07-13T09:00:00.000Z'),
    updatedAt: new Date('2026-07-13T09:00:00.000Z'),
    ...data,
    async save() {
      this.updatedAt = new Date('2026-07-13T09:15:00.000Z');
      return this;
    },
    toObject() {
      const { save, toObject, ...plain } = this;
      return plain;
    },
  };
  return doc;
}

function makeAira(data = {}) {
  return {
    _id: data._id || new mongoose.Types.ObjectId(),
    title: 'AIRA Bulletin',
    language: 'English',
    bulletinType: 'Morning',
    videoUrl: 'https://cdn.example.com/aira.mp4',
    status: 'Approved',
    ...data,
  };
}

function stubDbReady(t) {
  const prevReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = prevReadyState; });
}

function matchFilter(doc, filter = {}) {
  for (const [key, value] of Object.entries(filter || {})) {
    if (key === 'status' && value && value.$in) {
      if (!value.$in.includes(doc.status)) return false;
      continue;
    }
    if (key === 'date' && value && value.$gte) {
      if (String(doc.date) < String(value.$gte)) return false;
      continue;
    }
    if (doc[key] !== value) return false;
  }
  return true;
}

function stubLiveTvSchedule(t, store) {
  const prevCreate = LiveTvSchedule.create;
  const prevFind = LiveTvSchedule.find;
  const prevFindById = LiveTvSchedule.findById;
  const prevFindByIdAndUpdate = LiveTvSchedule.findByIdAndUpdate;
  const prevFindByIdAndDelete = LiveTvSchedule.findByIdAndDelete;

  LiveTvSchedule.create = async (payload) => {
    const doc = makeSchedule(payload);
    store.set(String(doc._id), doc);
    return doc;
  };
  LiveTvSchedule.find = (filter = {}) => ({
    sort() { return this; },
    async lean() {
      return Array.from(store.values()).filter((doc) => matchFilter(doc, filter)).map((doc) => doc.toObject());
    },
  });
  LiveTvSchedule.findById = async (id) => store.get(String(id)) || null;
  LiveTvSchedule.findByIdAndUpdate = async (id, update) => {
    const doc = store.get(String(id));
    if (!doc) return null;
    Object.assign(doc, update && update.$set ? update.$set : update);
    return doc;
  };
  LiveTvSchedule.findByIdAndDelete = async (id) => {
    const doc = store.get(String(id));
    if (!doc) return null;
    store.delete(String(id));
    return doc;
  };

  t.after(() => {
    LiveTvSchedule.create = prevCreate;
    LiveTvSchedule.find = prevFind;
    LiveTvSchedule.findById = prevFindById;
    LiveTvSchedule.findByIdAndUpdate = prevFindByIdAndUpdate;
    LiveTvSchedule.findByIdAndDelete = prevFindByIdAndDelete;
  });
}

function stubAira(t, store) {
  const prevFindById = AiraBulletin.findById;
  AiraBulletin.findById = async (id) => store.get(String(id)) || null;
  t.after(() => { AiraBulletin.findById = prevFindById; });
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

test('Live TV schedule CRUD validates approved AIRA bulletin and overlap warnings', async (t) => {
  stubDbReady(t);
  const scheduleStore = new Map();
  const airaId = new mongoose.Types.ObjectId();
  stubLiveTvSchedule(t, scheduleStore);
  stubAira(t, new Map([[String(airaId), makeAira({ _id: airaId, videoUrl: 'https://cdn.example.com/aira-approved.mp4' })]]));
  stubPublicSiteSettings(t, { draft: baseSettings(), published: baseSettings(), async save() { return this; } });
  const token = makeOpaqueAdminToken();

  const createRes = await request(app)
    .post('/api/live-tv/schedule')
    .set('Authorization', `Bearer ${token}`)
    .send({
      programTitle: 'AIRA Morning Slot',
      sourceType: 'aira_bulletin',
      label: 'SCHEDULED',
      date: '2026-07-14',
      startTime: '08:00',
      endTime: '08:10',
      selectedAiraBulletinId: String(airaId),
    });

  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.schedule.sourceType, 'aira_bulletin');
  assert.equal(createRes.body.schedule.videoUrl, 'https://cdn.example.com/aira-approved.mp4');

  const overlapRes = await request(app)
    .post('/api/live-tv/schedule')
    .set('Authorization', `Bearer ${token}`)
    .send({
      programTitle: 'Overlap Slot',
      sourceType: 'custom_embed',
      label: 'LIVE',
      date: '2026-07-14',
      startTime: '08:05',
      endTime: '08:15',
      embedUrl: 'https://player.example.com/live',
    });

  assert.equal(overlapRes.status, 409);
  assert.equal(overlapRes.body.code, 'LIVE_TV_SCHEDULE_TIME_OVERLAP');
  assert.equal(overlapRes.body.warning, 'SCHEDULE_TIME_OVERLAP');
  assert.equal(overlapRes.body.overlaps.length, 1);

  const forcedRes = await request(app)
    .post('/api/live-tv/schedule')
    .set('Authorization', `Bearer ${token}`)
    .send({
      programTitle: 'Forced Slot',
      sourceType: 'custom_embed',
      label: 'LIVE',
      date: '2026-07-14',
      startTime: '08:05',
      endTime: '08:15',
      embedUrl: 'https://player.example.com/live',
      forceSave: true,
    });

  assert.equal(forcedRes.status, 201);
  assert.equal(forcedRes.body.warning, 'SCHEDULE_TIME_OVERLAP');

  const listRes = await request(app).get('/api/live-tv/schedule').set('Authorization', `Bearer ${token}`);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.schedule.length, 2);
});

test('Live TV schedule activate, disable, delete, manual override, and resume schedule work locally', async (t) => {
  stubDbReady(t);
  const scheduleId = new mongoose.Types.ObjectId();
  const scheduleStore = new Map([[String(scheduleId), makeSchedule({
    _id: scheduleId,
    programTitle: 'Prime Live',
    sourceType: 'youtube_live',
    label: 'LIVE',
    date: '2026-07-14',
    startTime: '20:00',
    endTime: '20:30',
    embedUrl: 'https://www.youtube.com/watch?v=SLDHOwReM-Q',
    status: 'scheduled',
  })]]);
  stubLiveTvSchedule(t, scheduleStore);
  stubAira(t, new Map());
  let saveCount = 0;
  stubPublicSiteSettings(t, {
    draft: baseSettings({ status: 'replay', sourceType: 'offline_replay', fallbackVideoUrl: 'https://cdn.example.com/replay.mp4' }),
    published: baseSettings({ status: 'replay', sourceType: 'offline_replay', fallbackVideoUrl: 'https://cdn.example.com/replay.mp4' }),
    async save() { saveCount += 1; return this; },
  });
  const token = makeOpaqueAdminToken();

  const activate = await request(app).post(`/api/live-tv/schedule/${scheduleId}/activate-now`).set('Authorization', `Bearer ${token}`).send({});
  assert.equal(activate.status, 200);
  assert.equal(activate.body.schedule.status, 'active');
  assert.equal(activate.body.liveTv.sourceType, 'youtube_live');
  assert.equal(activate.body.liveTv.scheduleEntryId, String(scheduleId));
  assert.equal(saveCount, 1);

  const override = await request(app)
    .post('/api/live-tv/manual-override')
    .set('Authorization', `Bearer ${token}`)
    .send({ sourceType: 'breaking_bulletin', title: 'Breaking Desk', label: 'BREAKING BULLETIN', videoUrl: 'https://cdn.example.com/breaking.mp4' });
  assert.equal(override.status, 200);
  assert.equal(override.body.currentSource.sourceType, 'breaking_bulletin');

  const current = await request(app).get('/api/live-tv/current-source');
  assert.equal(current.status, 200);
  assert.equal(current.body.sourceType, 'breaking_bulletin');
  assert.equal(current.body.title, 'Breaking Desk');

  const resume = await request(app).post('/api/live-tv/resume-schedule').set('Authorization', `Bearer ${token}`).send({});
  assert.equal(resume.status, 200);
  assert.equal(resume.body.currentSource.sourceType, 'youtube_live');

  const disable = await request(app).post(`/api/live-tv/schedule/${scheduleId}/disable`).set('Authorization', `Bearer ${token}`).send({});
  assert.equal(disable.status, 200);
  assert.equal(disable.body.schedule.status, 'disabled');

  const deleted = await request(app).delete(`/api/live-tv/schedule/${scheduleId}`).set('Authorization', `Bearer ${token}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);
});

test('Live TV schedule validation returns clean source errors', async (t) => {
  stubDbReady(t);
  stubLiveTvSchedule(t, new Map());
  const rejectedId = new mongoose.Types.ObjectId();
  stubAira(t, new Map([[String(rejectedId), makeAira({ _id: rejectedId, status: 'Draft' })]]));
  stubPublicSiteSettings(t, { draft: baseSettings(), published: baseSettings(), async save() { return this; } });
  const token = makeOpaqueAdminToken();

  const invalidSource = await request(app)
    .post('/api/live-tv/schedule')
    .set('Authorization', `Bearer ${token}`)
    .send({ programTitle: 'Bad Source', sourceType: 'bad', label: 'LIVE', date: '2026-07-14', startTime: '08:00', endTime: '08:30' });
  assert.equal(invalidSource.status, 400);
  assert.equal(invalidSource.body.code, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');

  const missingVideo = await request(app)
    .post('/api/live-tv/schedule')
    .set('Authorization', `Bearer ${token}`)
    .send({ programTitle: 'Manual Live', sourceType: 'youtube_live', label: 'LIVE', date: '2026-07-14', startTime: '08:00', durationMinutes: 30 });
  assert.equal(missingVideo.status, 400);
  assert.equal(missingVideo.body.code, 'LIVE_TV_SCHEDULE_INVALID_SOURCE');

  const unapprovedAira = await request(app)
    .post('/api/live-tv/schedule')
    .set('Authorization', `Bearer ${token}`)
    .send({ programTitle: 'AIRA Draft', sourceType: 'aira_bulletin', label: 'SCHEDULED', date: '2026-07-14', startTime: '08:00', durationMinutes: 30, selectedAiraBulletinId: String(rejectedId) });
  assert.equal(unapprovedAira.status, 409);
  assert.equal(unapprovedAira.body.code, 'AIRA_BULLETIN_NOT_APPROVED');
});