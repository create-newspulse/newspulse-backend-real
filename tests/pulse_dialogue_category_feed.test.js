const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');
const Contributor = require('../models/Contributor');

const CONTRIBUTOR_ID = '507f1f77bcf86cd799439d01';
const CONTRIBUTOR_PHOTO = {
  url: 'https://cdn.example.test/pulse-writer.jpg',
  publicId: 'pulse-writer-photo',
  alt: 'Pulse Writer portrait',
};
const COVER_PHOTO = {
  url: 'https://cdn.example.test/pulse-cover.jpg',
  publicId: 'pulse-cover-photo',
  alt: 'Pulse story cover',
};

function getPathValue(doc, path) {
  return String(path || '').split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), doc);
}

function matchesValue(actual, expected) {
  if (expected instanceof RegExp) return expected.test(String(actual || ''));
  if (expected && typeof expected === 'object') {
    if (Object.prototype.hasOwnProperty.call(expected, '$in')) {
      const values = Array.isArray(expected.$in) ? expected.$in : [];
      return values.some((value) => matchesValue(actual, value));
    }
    if (Object.prototype.hasOwnProperty.call(expected, '$ne')) return actual !== expected.$ne;
    if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
      const exists = actual !== undefined;
      return exists === Boolean(expected.$exists);
    }
    if (Object.prototype.hasOwnProperty.call(expected, '$lte')) {
      return new Date(actual || 0).getTime() <= new Date(expected.$lte).getTime();
    }
  }
  if (expected === null) return actual === null || actual === undefined;
  return actual === expected;
}

function matchesQuery(doc, query) {
  if (!query || typeof query !== 'object') return true;
  if (Array.isArray(query.$and) && !query.$and.every((clause) => matchesQuery(doc, clause))) return false;
  if (Array.isArray(query.$or) && !query.$or.some((clause) => matchesQuery(doc, clause))) return false;

  for (const [key, expected] of Object.entries(query)) {
    if (key === '$and' || key === '$or') continue;
    if (!matchesValue(getPathValue(doc, key), expected)) return false;
  }
  return true;
}

function makeNewsQuery(items) {
  let working = Array.isArray(items) ? items.slice() : [];
  return {
    select() { return this; },
    sort(sortParam) {
      if (sortParam && typeof sortParam === 'object') {
        working = working.slice().sort((left, right) => {
          const publishedDiff = new Date(right.publishedAt || 0).getTime() - new Date(left.publishedAt || 0).getTime();
          if (publishedDiff) return publishedDiff;
          return new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
        });
      }
      return this;
    },
    skip() { return this; },
    limit() { return this; },
    lean: async () => working,
  };
}

function makeContributorQuery(items) {
  return { lean: async () => items };
}

function makePulseDoc(lang, overrides = {}) {
  const titles = { en: 'English Pulse Dialogue', hi: 'हिंदी पल्स संवाद', gu: 'ગુજરાતી પલ્સ સંવાદ' };
  const summaries = { en: 'English summary', hi: 'हिंदी सारांश', gu: 'ગુજરાતી સારાંશ' };
  return {
    _id: `507f1f77bcf86cd799439e0${lang === 'en' ? '1' : lang === 'hi' ? '2' : '3'}`,
    title: titles[lang],
    description: summaries[lang],
    content: `<p>${titles[lang]} body</p>`,
    slug: `pulse-dialogue-${lang}`,
    slugs: { en: 'pulse-dialogue-en', hi: 'pulse-dialogue-hi', gu: 'pulse-dialogue-gu' },
    category: 'pulse-dialogue',
    status: 'published',
    lang,
    language: lang,
    originalLang: lang,
    translationKey: 'pulse-dialogue-group-1',
    translationGroupId: 'pulse-dialogue-group-1',
    translations: {},
    translationStatus: {},
    publishedAt: '2020-09-24T10:00:00.000Z',
    createdAt: '2020-09-24T10:00:00.000Z',
    coverImage: COVER_PHOTO,
    pulseDialogue: {
      contributorId: CONTRIBUTOR_ID,
      dialogueFormat: 'essay',
      bylineSnapshot: null,
      showAboutContributor: true,
    },
    ...overrides,
  };
}

function makeVisiblePulseDataset() {
  return [
    makePulseDoc('en'),
    makePulseDoc('hi'),
    makePulseDoc('gu'),
    makePulseDoc('en', {
      _id: '507f1f77bcf86cd799439e04',
      title: 'Second Pulse Dialogue',
      slug: 'second-pulse-dialogue-en',
      slugs: { en: 'second-pulse-dialogue-en' },
      translationKey: 'pulse-dialogue-group-2',
      translationGroupId: 'pulse-dialogue-group-2',
      publishedAt: '2020-09-24T09:00:00.000Z',
      createdAt: '2020-09-24T09:00:00.000Z',
    }),
  ];
}

test('GET /api/public/news Pulse category includes public-safe contributor data for EN HI GU without N+1 lookup', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { newsFind: News.find, contributorFind: Contributor.find, contributorFindById: Contributor.findById };
  const contributorFindQueries = [];

  try {
    mongoose.connection.readyState = 1;
    const docs = makeVisiblePulseDataset();

    News.find = (query) => makeNewsQuery(docs.filter((doc) => matchesQuery(doc, query)));
    Contributor.findById = () => { throw new Error('category feed should batch contributor lookup'); };
    Contributor.find = (query) => {
      contributorFindQueries.push(query);
      return makeContributorQuery([{
        _id: CONTRIBUTOR_ID,
        canonicalName: 'Pulse Writer',
        displayNameHi: 'पल्स लेखक',
        displayNameGu: 'પલ્સ લેખક',
        publicDesignation: 'Columnist',
        affiliation: 'News Pulse Forum',
        shortBio: 'Writes for public readers.',
        status: 'active',
        photo: CONTRIBUTOR_PHOTO,
        internalEmail: 'private@example.test',
        internalNotes: 'private note',
        rightsConsent: { notes: 'private rights note' },
      }]);
    };

    const expected = {
      en: { title: 'English Pulse Dialogue', name: 'Pulse Writer' },
      hi: { title: 'हिंदी पल्स संवाद', name: 'पल्स लेखक' },
      gu: { title: 'ગુજરાતી પલ્સ સંવાદ', name: 'પલ્સ લેખક' },
    };

    for (const lang of ['en', 'hi', 'gu']) {
      contributorFindQueries.length = 0;
      const res = await request(app).get(`/api/public/news?category=pulse-dialogue&lang=${lang}&limit=10&page=1`);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.items.length, 2);
      assert.equal(contributorFindQueries.length, 1);
      assert.deepEqual(contributorFindQueries[0]._id.$in, [CONTRIBUTOR_ID]);

      const item = res.body.items.find((entry) => entry.translationGroupId === 'pulse-dialogue-group-1');
      assert.ok(item, `expected Pulse item for ${lang}`);
      assert.equal(item.title, expected[lang].title);
      assert.equal(item.pulseDialogue.contributorId, CONTRIBUTOR_ID);
      assert.equal(item.pulseDialogue.bylineSnapshot.name, expected[lang].name);
      assert.equal(item.pulseDialogue.bylineSnapshot.designation, 'Columnist');
      assert.equal(item.pulseDialogue.bylineSnapshot.affiliation, 'News Pulse Forum');
      assert.deepEqual(item.pulseDialogue.bylineSnapshot.photo, CONTRIBUTOR_PHOTO);
      assert.equal(item.pulseDialogue.contributor.canonicalName, 'Pulse Writer');
      assert.equal(item.pulseDialogue.contributor.publicDesignation, 'Columnist');
      assert.equal(item.pulseDialogue.contributor.affiliation, 'News Pulse Forum');
      assert.deepEqual(item.pulseDialogue.contributor.photo, CONTRIBUTOR_PHOTO);
      assert.notDeepEqual(item.pulseDialogue.contributor.photo, COVER_PHOTO);
      assert.equal(item.pulseDialogue.contributor.internalEmail, undefined);
      assert.equal(item.pulseDialogue.contributor.internalNotes, undefined);
      assert.equal(item.pulseDialogue.contributor.rightsConsent, undefined);
    }
  } finally {
    News.find = originals.newsFind;
    Contributor.find = originals.contributorFind;
    Contributor.findById = originals.contributorFindById;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news Pulse category keeps no-photo contributor safe and never uses cover as portrait', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { newsFind: News.find, contributorFind: Contributor.find };

  try {
    mongoose.connection.readyState = 1;
    const noPhotoContributorId = '507f1f77bcf86cd799439d02';
    const docs = [makePulseDoc('en', {
      pulseDialogue: { contributorId: noPhotoContributorId, dialogueFormat: 'essay', bylineSnapshot: null },
    })];

    News.find = (query) => makeNewsQuery(docs.filter((doc) => matchesQuery(doc, query)));
    Contributor.find = () => makeContributorQuery([{
      _id: noPhotoContributorId,
      canonicalName: 'No Photo Writer',
      publicDesignation: 'Contributor',
      status: 'active',
      photo: null,
    }]);

    const res = await request(app).get('/api/public/news?category=pulse-dialogue&lang=en&limit=10&page=1');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].imageUrl, COVER_PHOTO.url);
    assert.equal(res.body.items[0].pulseDialogue.bylineSnapshot.name, 'No Photo Writer');
    assert.equal(res.body.items[0].pulseDialogue.bylineSnapshot.photo, null);
    assert.equal(res.body.items[0].pulseDialogue.contributor.photo, null);
  } finally {
    News.find = originals.newsFind;
    Contributor.find = originals.contributorFind;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news category feed leaves non-Pulse payload unchanged and skips contributor lookup', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { newsFind: News.find, contributorFind: Contributor.find };
  let contributorFindCount = 0;

  try {
    mongoose.connection.readyState = 1;
    const docs = [{
      _id: '507f1f77bcf86cd799439f01',
      title: 'National story',
      description: 'National summary',
      content: '<p>National body</p>',
      slug: 'national-story',
      category: 'national',
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      publishedAt: '2020-09-24T11:00:00.000Z',
      createdAt: '2020-09-24T11:00:00.000Z',
    }];

    News.find = (query) => makeNewsQuery(docs.filter((doc) => matchesQuery(doc, query)));
    Contributor.find = () => {
      contributorFindCount += 1;
      return makeContributorQuery([]);
    };

    const res = await request(app).get('/api/public/news?category=national&lang=en&limit=10&page=1');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].pulseDialogue, undefined);
    assert.equal(contributorFindCount, 0);
  } finally {
    News.find = originals.newsFind;
    Contributor.find = originals.contributorFind;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news Pulse category excludes unpublished deleted archived and scheduled stories', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { newsFind: News.find, contributorFind: Contributor.find };

  try {
    mongoose.connection.readyState = 1;
    const docs = [
      makePulseDoc('en'),
      makePulseDoc('en', { _id: '507f1f77bcf86cd799439f11', slug: 'draft-pulse', translationKey: 'bad-draft', translationGroupId: 'bad-draft', status: 'draft' }),
      makePulseDoc('en', { _id: '507f1f77bcf86cd799439f12', slug: 'deleted-pulse', translationKey: 'bad-deleted', translationGroupId: 'bad-deleted', deletedAt: '2026-09-24T12:00:00.000Z' }),
      makePulseDoc('en', { _id: '507f1f77bcf86cd799439f13', slug: 'archived-pulse', translationKey: 'bad-archived', translationGroupId: 'bad-archived', status: 'archived' }),
      makePulseDoc('en', { _id: '507f1f77bcf86cd799439f14', slug: 'future-pulse', translationKey: 'bad-future', translationGroupId: 'bad-future', publishedAt: '2999-01-01T00:00:00.000Z' }),
    ];

    News.find = (query) => makeNewsQuery(docs.filter((doc) => matchesQuery(doc, query)));
    Contributor.find = () => makeContributorQuery([{ _id: CONTRIBUTOR_ID, canonicalName: 'Pulse Writer', status: 'active', photo: CONTRIBUTOR_PHOTO }]);

    const res = await request(app).get('/api/public/news?category=pulse-dialogue&lang=en&limit=10&page=1');

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.items.map((item) => item.translationGroupId), ['pulse-dialogue-group-1']);
  } finally {
    News.find = originals.newsFind;
    Contributor.find = originals.contributorFind;
    mongoose.connection.readyState = prevReadyState;
  }
});