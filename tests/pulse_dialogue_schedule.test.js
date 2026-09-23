const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || 'test-key';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const Contributor = require('../models/Contributor');
const PushHistory = require('../models/PushHistory');
const { publishCanonicalArticle } = require('../services/articlePublishing.service');
const { publishDueScheduledArticles } = require('../services/scheduledPublication.service');
const { getPulseDialogueStandardText } = require('../services/pulseDialogue.service');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function queryDoc(doc) {
  return {
    select() { return this; },
    lean: async () => doc,
    then(resolve, reject) { return Promise.resolve(doc).then(resolve, reject); },
    catch(reject) { return Promise.resolve(doc).catch(reject); },
  };
}

function makeRouteDoc(overrides = {}) {
  const doc = {
    _id: overrides._id || '507f1f77bcf86cd79943a101',
    title: 'Pulse schedule draft',
    description: 'Pulse schedule summary',
    content: '<p>Pulse schedule body</p>',
    category: 'pulse-dialogue',
    status: 'draft',
    language: 'en',
    lang: 'en',
    originalLang: 'en',
    slug: 'pulse-schedule-draft',
    slugs: { en: 'pulse-schedule-draft' },
    tags: [],
    sourceArticleId: '507f1f77bcf86cd79943afff',
    translationGroupId: 'pulse-schedule-route-group',
    translationKey: 'pulse-schedule-route-group',
    workflowStage: 'DRAFT',
    workflowHistory: [],
    ...overrides,
  };
  doc.save = async () => doc;
  doc.toObject = () => ({ ...doc });
  doc.toJSON = () => ({ ...doc });
  return doc;
}

function makePublishDoc(lang, overrides = {}) {
  const labels = {
    en: ['Pulse English', 'Pulse English summary', '<p>Pulse English body</p>', 'pulse-english'],
    hi: ['पल्स हिंदी', 'पल्स हिंदी सारांश', '<p>पल्स हिंदी लेख</p>', 'pulse-hindi'],
    gu: ['પલ્સ ગુજરાતી', 'પલ્સ ગુજરાતી સારાંશ', '<p>પલ્સ ગુજરાતી લેખ</p>', 'pulse-gujarati'],
  };
  const [title, description, content, slug] = labels[lang];
  const contributorId = overrides.contributorId || '507f1f77bcf86cd79943a001';
  const doc = {
    _id: overrides._id || `507f1f77bcf86cd79943a10${lang === 'en' ? '1' : lang === 'hi' ? '2' : '3'}`,
    title,
    description,
    content,
    slug,
    slugs: { [lang]: slug },
    category: 'pulse-dialogue',
    status: overrides.status || 'scheduled',
    scheduledAt: overrides.scheduledAt || new Date('2026-09-23T09:00:00.000Z'),
    publishAt: overrides.publishAt || new Date('2026-09-23T09:00:00.000Z'),
    language: lang,
    lang,
    originalLang: lang,
    sourceArticleId: lang === 'en' ? undefined : '507f1f77bcf86cd79943a101',
    sourceLanguage: 'en',
    translationGroupId: 'pulse-schedule-publish-group',
    translationKey: 'pulse-schedule-publish-group',
    workflowStage: 'SCHEDULED',
    workflowHistory: [],
    pulseDialogue: {
      contributorId,
      dialogueFormat: 'essay',
      bylineDesignationOverride: 'Senior Columnist',
      showAboutContributor: true,
    },
    saveCount: 0,
    ...overrides,
  };
  doc.save = async () => {
    doc.saveCount += 1;
    return doc;
  };
  doc.toObject = () => ({ ...doc });
  doc.toJSON = () => ({ ...doc });
  return doc;
}

function restore(originals) {
  for (const item of originals) {
    for (const [key, value] of Object.entries(item.values)) item.target[key] = value;
  }
}

function installRouteMocks(t, beforeDoc, contributor) {
  const originals = [
    { target: News, values: { findById: News.findById, findByIdAndUpdate: News.findByIdAndUpdate, find: News.find, findOne: News.findOne } },
    { target: Contributor, values: { findById: Contributor.findById } },
    { target: PublicArticle, values: { findOneAndUpdate: PublicArticle.findOneAndUpdate } },
  ];
  const capturedUpdates = [];

  News.findById = () => ({ select: () => ({ lean: async () => beforeDoc }) });
  News.find = async () => [];
  News.findOne = () => queryDoc(null);
  News.findByIdAndUpdate = async (_id, op) => {
    capturedUpdates.push(op);
    const doc = makeRouteDoc({ ...beforeDoc, ...(op && op.$set ? op.$set : {}) });
    return doc;
  };
  Contributor.findById = () => ({ lean: async () => contributor });
  PublicArticle.findOneAndUpdate = () => ({ lean: async () => ({ _id: 'public-route-copy' }) });

  t.after(() => restore(originals));
  return { capturedUpdates };
}

function installPublishMocks(t, docs) {
  const originals = [
    { target: News, values: { find: News.find, findById: News.findById, findOne: News.findOne, create: News.create, updateOne: News.updateOne } },
    { target: Contributor, values: { findById: Contributor.findById } },
    { target: PublicArticle, values: { findOneAndUpdate: PublicArticle.findOneAndUpdate, updateMany: PublicArticle.updateMany } },
    { target: PushHistory, values: { create: PushHistory.create } },
  ];
  const publicUpdates = [];
  const pushHistory = [];

  News.findById = async (id) => docs.find((doc) => String(doc._id) === String(id)) || null;
  News.find = (query = {}) => {
    if (query.status === 'scheduled') {
      return { limit: async () => docs.filter((doc) => doc.status === 'scheduled') };
    }
    return docs.filter((doc) => doc.translationGroupId === 'pulse-schedule-publish-group' || doc.translationKey === 'pulse-schedule-publish-group');
  };
  News.findOne = () => queryDoc(null);
  News.create = async (payload) => {
    const doc = makePublishDoc(payload.language || payload.lang || 'en', payload);
    docs.push(doc);
    return doc;
  };
  News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
  Contributor.findById = () => ({
    lean: async () => ({
      _id: '507f1f77bcf86cd79943a001',
      canonicalName: 'Public Pulse Writer',
      publicDesignation: 'Columnist',
      affiliation: 'News Pulse Forum',
      shortBio: 'Writes public essays.',
      slug: 'public-pulse-writer',
      status: 'active',
      photo: { url: 'https://cdn.example.test/public-pulse-writer.jpg', publicId: 'public-pulse-writer-photo', alt: 'Public Pulse Writer portrait' },
      internalEmail: 'private@example.test',
      internalNotes: 'private note',
      rightsConsent: { notes: 'private consent' },
    }),
  });
  PublicArticle.findOneAndUpdate = (_query, update) => {
    publicUpdates.push(update);
    return { lean: async () => ({ _id: `public-${publicUpdates.length}`, pulseDialogue: update.$set.pulseDialogue }) };
  };
  PublicArticle.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });
  PushHistory.create = async (payload) => {
    pushHistory.push(payload);
    return { _id: `push-${pushHistory.length}` };
  };

  t.after(() => restore(originals));
  return { publicUpdates, pushHistory };
}

test('Pulse Dialogue draft still saves without publication metadata', async (t) => {
  const id = '507f1f77bcf86cd79943a111';
  const beforeDoc = makeRouteDoc({ _id: id, category: 'national', pulseDialogue: undefined });
  const { capturedUpdates } = installRouteMocks(t, beforeDoc, null);

  const res = await request(app)
    .put(`/api/articles/${id}`)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ category: 'pulse-dialogue' });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(capturedUpdates[0].$set.category, 'pulse-dialogue');
  assert.equal(Object.prototype.hasOwnProperty.call(capturedUpdates[0].$set, 'pulseDialogue'), false);
});

test('PUT scheduling rejects invalid Pulse contributor metadata', async (t) => {
  const id = '507f1f77bcf86cd79943a112';
  const contributorId = '507f1f77bcf86cd79943a001';
  const beforeDoc = makeRouteDoc({
    _id: id,
    pulseDialogue: { contributorId, dialogueFormat: 'essay' },
  });
  const { capturedUpdates } = installRouteMocks(t, beforeDoc, {
    _id: contributorId,
    canonicalName: 'Inactive Writer',
    status: 'inactive',
  });

  const res = await request(app)
    .put(`/api/articles/${id}`)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ status: 'scheduled', scheduledAt: '2026-09-23T10:00:00.000Z' });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /activeContributor/);
  assert.equal(capturedUpdates.length, 0);
});

test('PUT scheduling preserves valid Pulse metadata and stores byline snapshot', async (t) => {
  const id = '507f1f77bcf86cd79943a113';
  const contributorId = '507f1f77bcf86cd79943a001';
  const beforeDoc = makeRouteDoc({
    _id: id,
    pulseDialogue: { contributorId, dialogueFormat: 'essay', bylineDesignationOverride: 'Guest Columnist' },
  });
  const { capturedUpdates } = installRouteMocks(t, beforeDoc, {
    _id: contributorId,
    canonicalName: 'Active Writer',
    publicDesignation: 'Columnist',
    affiliation: 'News Pulse Forum',
    status: 'active',
  });

  const res = await request(app)
    .put(`/api/articles/${id}`)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ status: 'scheduled', scheduledAt: '2026-09-23T10:00:00.000Z' });

  assert.equal(res.status, 200);
  const scheduledUpdate = capturedUpdates.find((op) => op?.$set?.status === 'scheduled');
  assert.ok(scheduledUpdate, 'expected scheduled update to be saved');
  assert.equal(scheduledUpdate.$set.pulseDialogue.contributorId, contributorId);
  assert.equal(scheduledUpdate.$set.pulseDialogue.dialogueFormat, 'essay');
  assert.equal(scheduledUpdate.$set.pulseDialogue.bylineSnapshot.name, 'Active Writer');
  assert.equal(scheduledUpdate.$set.pulseDialogue.bylineSnapshot.designation, 'Guest Columnist');
});

test('PUT non-Pulse scheduling remains a normal scheduled status update', async (t) => {
  const id = '507f1f77bcf86cd79943a114';
  const beforeDoc = makeRouteDoc({ _id: id, category: 'national', pulseDialogue: undefined });
  const { capturedUpdates } = installRouteMocks(t, beforeDoc, null);

  const res = await request(app)
    .put(`/api/articles/${id}`)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ status: 'scheduled', scheduledAt: '2026-09-23T10:00:00.000Z' });

  assert.equal(res.status, 200);
  const scheduledUpdate = capturedUpdates.find((op) => op?.$set?.status === 'scheduled');
  assert.ok(scheduledUpdate, 'expected non-Pulse scheduled update');
  assert.equal(Object.prototype.hasOwnProperty.call(scheduledUpdate.$set, 'pulseDialogue'), false);
});

test('due Pulse scheduled article publishes through canonical pipeline and syncs public-safe data', async (t) => {
  const docs = [makePublishDoc('en'), makePublishDoc('hi'), makePublishDoc('gu')];
  const { publicUpdates, pushHistory } = installPublishMocks(t, docs);

  const stats = await publishDueScheduledArticles({ allowDisconnected: true, now: new Date('2026-09-23T10:00:00.000Z') });

  assert.equal(stats.processed, 3);
  assert.equal(stats.published, 1);
  assert.equal(stats.skipped, 2);
  assert.equal(stats.failed, 0);
  for (const doc of docs) {
    const standard = getPulseDialogueStandardText(doc.language);
    assert.equal(doc.status, 'published');
    assert.equal(doc.scheduledAt, null);
    assert.equal(doc.publishAt, null);
    assert.equal(doc.workflowStage, 'PUBLISHED');
    assert.equal(doc.pulseDialogue.contributorId, '507f1f77bcf86cd79943a001');
    assert.equal(doc.pulseDialogue.bylineSnapshot.name, 'Public Pulse Writer');
    assert.deepEqual(doc.pulseDialogue.bylineSnapshot.photo, { url: 'https://cdn.example.test/public-pulse-writer.jpg', publicId: 'public-pulse-writer-photo', alt: 'Public Pulse Writer portrait' });
    assert.equal(doc.pulseDialogue.contributorDisclosure, standard.contributorDisclosure);
    assert.equal(doc.pulseDialogue.contributorDisclaimer, standard.contributorDisclaimer);
  }
  assert.equal(publicUpdates.length, 3);
  for (const update of publicUpdates) {
    const standard = getPulseDialogueStandardText(update.$set.language);
    assert.equal(update.$set.pulseDialogue.contributorDisclosure, standard.contributorDisclosure);
    assert.equal(update.$set.pulseDialogue.contributorDisclaimer, standard.contributorDisclaimer);
    assert.deepEqual(update.$set.pulseDialogue.bylineSnapshot.photo, { url: 'https://cdn.example.test/public-pulse-writer.jpg', publicId: 'public-pulse-writer-photo', alt: 'Public Pulse Writer portrait' });
    assert.deepEqual(update.$set.pulseDialogue.contributor.photo, { url: 'https://cdn.example.test/public-pulse-writer.jpg', publicId: 'public-pulse-writer-photo', alt: 'Public Pulse Writer portrait' });
  }
  const publicPulse = publicUpdates[0].$set.pulseDialogue;
  assert.equal(publicPulse.contributorId, '507f1f77bcf86cd79943a001');
  assert.equal(publicPulse.contributor.name, 'Public Pulse Writer');
  assert.equal(publicPulse.contributor.shortBio, 'Writes public essays.');
  assert.equal(publicPulse.contributor.internalEmail, undefined);
  assert.equal(publicPulse.contributor.internalNotes, undefined);
  assert.equal(publicPulse.contributor.rightsConsent, undefined);
  assert.equal(pushHistory.length, 1);
  assert.equal(pushHistory[0].meta.source, 'scheduler');
});

test('non-Pulse due scheduling keeps legacy scheduler publish behavior', async (t) => {
  const doc = makeRouteDoc({
    _id: '507f1f77bcf86cd79943a115',
    category: 'national',
    status: 'scheduled',
    scheduledAt: new Date('2026-09-23T09:00:00.000Z'),
    publishAt: new Date('2026-09-23T09:00:00.000Z'),
    workflowStage: 'SCHEDULED',
    pulseDialogue: undefined,
  });
  const pushHistory = [];
  const NewsStub = { find: () => ({ limit: async () => [doc] }) };
  const PushHistoryStub = { create: async (payload) => { pushHistory.push(payload); return payload; } };
  let canonicalCalls = 0;

  const stats = await publishDueScheduledArticles({
    allowDisconnected: true,
    now: new Date('2026-09-23T10:00:00.000Z'),
    News: NewsStub,
    PushHistory: PushHistoryStub,
    publishCanonicalArticle: async () => { canonicalCalls += 1; },
  });

  assert.equal(stats.processed, 1);
  assert.equal(stats.published, 1);
  assert.equal(canonicalCalls, 0);
  assert.equal(doc.status, 'published');
  assert.equal(doc.publishAt, null);
  assert.equal(doc.workflowStage, 'PUBLISHED');
  assert.equal(pushHistory.length, 1);
  assert.equal(pushHistory[0].meta.source, 'scheduler');
});

test('manual Pulse publish still prepares byline snapshot and public sync', async (t) => {
  const docs = [makePublishDoc('en'), makePublishDoc('hi'), makePublishDoc('gu')];
  const { publicUpdates } = installPublishMocks(t, docs);

  const result = await publishCanonicalArticle(docs[0], {
    actor: { byUserId: null, byRole: 'Founder' },
    reason: 'manual pulse publish test',
    source: 'manual_pulse_test',
    now: new Date('2026-09-23T10:00:00.000Z'),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.publishedLanguages.sort(), ['en', 'gu', 'hi']);
  assert.equal(docs[0].pulseDialogue.bylineSnapshot.name, 'Public Pulse Writer');
  assert.equal(publicUpdates.length, 3);
  for (const update of publicUpdates) {
    const standard = getPulseDialogueStandardText(update.$set.language);
    assert.equal(update.$set.pulseDialogue.contributorDisclosure, standard.contributorDisclosure);
    assert.equal(update.$set.pulseDialogue.contributorDisclaimer, standard.contributorDisclaimer);
  }
  assert.equal(publicUpdates[0].$set.pulseDialogue.contributor.internalEmail, undefined);
});

test('manual Pulse republish repairs existing published null byline snapshot', async (t) => {
  const docs = [
    makePublishDoc('en', { status: 'published', publishedAt: new Date('2026-09-20T10:00:00.000Z'), pulseDialogue: { contributorId: '507f1f77bcf86cd79943a001', dialogueFormat: 'essay', bylineSnapshot: null } }),
    makePublishDoc('hi', { status: 'published', publishedAt: new Date('2026-09-20T10:00:00.000Z'), pulseDialogue: { contributorId: '507f1f77bcf86cd79943a001', dialogueFormat: 'essay', bylineSnapshot: null } }),
    makePublishDoc('gu', { status: 'published', publishedAt: new Date('2026-09-20T10:00:00.000Z'), pulseDialogue: { contributorId: '507f1f77bcf86cd79943a001', dialogueFormat: 'essay', bylineSnapshot: null } }),
  ];
  const { publicUpdates } = installPublishMocks(t, docs);

  const result = await publishCanonicalArticle(docs[0], {
    actor: { byUserId: null, byRole: 'Founder' },
    reason: 'manual pulse republish repair test',
    source: 'manual_pulse_republish_test',
    now: new Date('2026-09-23T10:00:00.000Z'),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.publishedLanguages.sort(), ['en', 'gu', 'hi']);
  for (const doc of docs) {
    assert.equal(doc.pulseDialogue.bylineSnapshot.name, 'Public Pulse Writer');
    assert.deepEqual(doc.pulseDialogue.bylineSnapshot.photo, { url: 'https://cdn.example.test/public-pulse-writer.jpg', publicId: 'public-pulse-writer-photo', alt: 'Public Pulse Writer portrait' });
  }
  assert.equal(publicUpdates.length, 3);
  for (const update of publicUpdates) {
    assert.deepEqual(update.$set.pulseDialogue.bylineSnapshot.photo, { url: 'https://cdn.example.test/public-pulse-writer.jpg', publicId: 'public-pulse-writer-photo', alt: 'Public Pulse Writer portrait' });
    assert.deepEqual(update.$set.pulseDialogue.contributor.photo, { url: 'https://cdn.example.test/public-pulse-writer.jpg', publicId: 'public-pulse-writer-photo', alt: 'Public Pulse Writer portrait' });
  }
});