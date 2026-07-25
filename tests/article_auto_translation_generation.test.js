const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || 'test-key';

const News = require('../models/News');
const app = require('../server');
const googleTranslation = require('../services/googleTranslationService');
const {
  generateArticleTranslations,
} = require('../services/articleTranslationGeneration.service');

function restore(originals) {
  for (const [key, value] of Object.entries(originals)) News[key] = value;
}

function makeSource(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439501',
    title: 'News Pulse launches AIRA',
    description: 'AIRA summary with https://newspulse.ai and #NewsPulse',
    content: '<p>News Pulse story with <a href="https://newspulse.ai">link</a>.</p>',
    slug: 'news-pulse-launches-aira',
    slugs: { en: 'news-pulse-launches-aira' },
    category: 'national',
    tags: ['tech'],
    status: 'draft',
    lang: 'en',
    language: 'en',
    originalLang: 'en',
    translationGroupId: 'grp-auto-1',
    translationKey: 'grp-auto-1',
    coverImage: { url: '/uploads/a.jpg', alt: 'AIRA logo' },
    seo: { metaTitle: 'SEO title', metaDescription: 'SEO description' },
    ...overrides,
  };
}

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function makeOpaqueFounderToken() {
  return makeOpaqueAdminToken('founder@example.com');
}

test('googleTranslationService preserves protected terms, URLs, hashtags, and retries temporary errors', async () => {
  let calls = 0;
  const fetchImpl = async (_url, opts) => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 429, json: async () => ({ error: { message: 'rate limit' } }) };
    }
    const body = JSON.parse(String(opts.body || '{}'));
    const q = Array.isArray(body.q) ? body.q : [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: q.map((item) => ({ translatedText: `હેલો ${item}` })) } }),
    };
  };

  const res = await googleTranslation.translateText(
    '<p>News Pulse and AIRA visit https://newspulse.ai #NewsPulse</p>',
    'en',
    'gu',
    { format: 'html', fetchImpl, maxRetries: 1 }
  );

  assert.equal(res.ok, true);
  assert.equal(calls, 2);
  assert.match(res.text, /<p>/);
  assert.match(res.text, /News Pulse/);
  assert.match(res.text, /AIRA/);
  assert.match(res.text, /https:\/\/newspulse\.ai/);
  assert.match(res.text, /#NewsPulse/);
});

test('googleTranslationService chunks long HTML and reassembles in order', async () => {
  const chunks = [];
  const fetchImpl = async (_url, opts) => {
    const body = JSON.parse(String(opts.body || '{}'));
    const q = Array.isArray(body.q) ? body.q : [];
    chunks.push(...q);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: q.map((item) => ({ translatedText: `[${item.slice(0, 4)}]` })) } }),
    };
  };
  const html = Array.from({ length: 30 }, (_, index) => `<p>Paragraph ${index} with News Pulse content.</p>`).join('');
  const res = await googleTranslation.translateText(html, 'en', 'hi', { format: 'html', maxChars: 180, fetchImpl });
  assert.equal(res.ok, true);
  assert.ok(chunks.length > 1);
  assert.equal(res.text, chunks.map((item) => `[${item.slice(0, 4)}]`).join(''));
});

test('English article generates Hindi and Gujarati sibling drafts only', async () => {
  const originals = { findOne: News.findOne, create: News.create, updateOne: News.updateOne };
  const prevFetch = global.fetch;
  const created = [];

  try {
    News.findOne = async () => null;
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.create = async (payload) => { created.push(payload); return { _id: `507f1f77bcf86cd7994395${created.length}1`, ...payload }; };
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: `T:${body.target}:${q}` })) } }) };
    };

    const res = await generateArticleTranslations(makeSource({ language: 'en', lang: 'en' }), { targetLanguages: ['en', 'hi', 'gu'] });
    assert.equal(res.ok, true);
    assert.deepEqual(Object.keys(res.created).sort(), ['gu', 'hi']);
    assert.deepEqual(created.map((item) => item.language).sort(), ['gu', 'hi']);
    assert.ok(created.every((item) => item.translationGroupId === 'grp-auto-1'));
    assert.ok(created.every((item) => item.status === 'draft'));
    assert.ok(created.every((item) => item.translationReviewStatus === 'review_required'));
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('Hindi and Gujarati source articles generate the other supported languages', async () => {
  const originals = { findOne: News.findOne, create: News.create, updateOne: News.updateOne };
  const prevFetch = global.fetch;
  try {
    News.findOne = async () => null;
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.create = async (payload) => ({ _id: `507f1f77bcf86cd799439${payload.language}1`, ...payload });
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: `${body.target}:${q}` })) } }) };
    };

    const hi = await generateArticleTranslations(makeSource({ language: 'hi', lang: 'hi', originalLang: 'hi' }), { targetLanguages: ['en', 'hi', 'gu'] });
    assert.deepEqual(Object.keys(hi.created).sort(), ['en', 'gu']);

    const gu = await generateArticleTranslations(makeSource({ language: 'gu', lang: 'gu', originalLang: 'gu' }), { targetLanguages: ['en', 'hi', 'gu'] });
    assert.deepEqual(Object.keys(gu.created).sort(), ['en', 'hi']);
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('Existing translation prevents duplicate language record and human-edited translation is not overwritten', async () => {
  const originals = { findOne: News.findOne, create: News.create, findByIdAndUpdate: News.findByIdAndUpdate, updateOne: News.updateOne };
  let createCalls = 0;
  let updateCalls = 0;
  const prevFetch = global.fetch;

  try {
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.findOne = async (query) => {
      const raw = JSON.stringify(query);
      if (raw.includes('"language":"hi"')) return { _id: '507f1f77bcf86cd799439601', language: 'hi', humanEdited: false };
      if (raw.includes('"language":"gu"')) return { _id: '507f1f77bcf86cd799439602', language: 'gu', humanEdited: true };
      return null;
    };
    News.create = async () => { createCalls += 1; return null; };
    News.findByIdAndUpdate = async () => { updateCalls += 1; return null; };
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: q })) } }) };
    };

    const res = await generateArticleTranslations(makeSource(), { targetLanguages: ['hi', 'gu'], overwrite: false });
    assert.equal(createCalls, 0);
    assert.equal(updateCalls, 0);
    assert.equal(res.skipped.hi.reason, 'exists');
    assert.equal(res.skipped.gu.reason, 'human_edited');
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('Failed translation returns failed status without losing source article', async () => {
  const originals = { findOne: News.findOne, create: News.create, updateOne: News.updateOne };
  const prevFetch = global.fetch;
  let createCalls = 0;
  try {
    News.findOne = async () => null;
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.create = async () => { createCalls += 1; return null; };
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'server error' } }) });

    const res = await generateArticleTranslations(makeSource(), { targetLanguages: ['hi'] });
    assert.equal(res.ok, false);
    assert.equal(res.status, 'failed');
    assert.equal(createCalls, 0);
    assert.ok(res.failed.hi.length >= 1);
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('POST /api/articles/:id/translations/generate creates target sibling drafts', async () => {
  const id = '507f1f77bcf86cd799439701';
  const originals = { findById: News.findById, findOne: News.findOne, create: News.create, updateOne: News.updateOne };
  const prevFetch = global.fetch;
  const created = [];
  try {
    News.findById = async () => makeSource({ _id: id, language: 'en', lang: 'en', originalLang: 'en', translationGroupId: 'grp-route-1', translationKey: 'grp-route-1' });
    News.findOne = async () => null;
    News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
    News.create = async (payload) => { created.push(payload); return { _id: `507f1f77bcf86cd7994397${created.length}2`, ...payload }; };
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: `${body.target}:${q}` })) } }) };
    };

    const res = await request(app)
      .post(`/api/articles/${id}/translations/generate`)
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({ targetLanguages: ['en', 'hi', 'gu'], overwrite: false });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(Object.keys(res.body.created).sort(), ['gu', 'hi']);
    assert.deepEqual(created.map((item) => item.language).sort(), ['gu', 'hi']);
    assert.ok(created.every((item) => item.translationReviewStatus === 'review_required'));
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});

test('POST /api/articles/translations/backfill requires Founder and double confirmation for execution', async () => {
  const originals = { find: News.find };
  try {
    News.find = () => ({
      select() { return this; },
      limit() { return this; },
      lean: async () => [makeSource()],
    });

    const adminRes = await request(app)
      .post('/api/articles/translations/backfill')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({ estimateOnly: true });
    assert.equal(adminRes.status, 403);

    const estimateRes = await request(app)
      .post('/api/articles/translations/backfill')
      .set('Authorization', `Bearer ${makeOpaqueFounderToken()}`)
      .send({ estimateOnly: true, onlyPublished: true, maxCount: 5 });
    assert.equal(estimateRes.status, 200);
    assert.equal(estimateRes.body.requiresConfirmation, true);
    assert.equal(estimateRes.body.confirmationText, 'GENERATE_TRANSLATIONS');
    assert.equal(estimateRes.body.estimatedArticleCount, 1);
  } finally {
    restore(originals);
  }
});