const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');
const mongoose = require('mongoose');
const News = require('../models/News');

function makeChainableQuery(items) {
  return {
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => items,
  };
}

function extractLangFilter(filter) {
  const ands = filter?.$and || [];
  for (const c of ands) {
    if (!c) continue;
    // Our controller adds the lang condition as an object that contains $or,
    // but other filters (published/status) also use $or. Pick the one that
    // actually references lang/language.
    if (Array.isArray(c.$or) && containsLangKeys(c)) return c;
  }
  return null;
}

function extractTranslationReadyFilter(filter, lang) {
  const desired = String(lang || '').trim().toLowerCase();
  const key = `translationStatus.${desired}`;
  const ands = filter?.$and || [];
  for (const c of ands) {
    if (!c || typeof c !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(c, key) && c[key] === 'ready') return c;
    if (Array.isArray(c.$and) && c.$and.some((x) => x && typeof x === 'object' && Object.prototype.hasOwnProperty.call(x, key) && x[key] === 'ready')) {
      return c;
    }
  }
  return null;
}

function containsTranslationReady(filter, lang) {
  const desired = String(lang || '').trim().toLowerCase();
  const key = `translationStatus.${desired}`;

  function walk(node) {
    if (!node || typeof node !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(node, key) && node[key] === 'ready') return true;
    if (Array.isArray(node)) return node.some(walk);
    if (Array.isArray(node.$and) && node.$and.some(walk)) return true;
    if (Array.isArray(node.$or) && node.$or.some(walk)) return true;
    return Object.values(node).some(walk);
  }

  return walk(filter);
}

function extractHiEnFeedOrFilter(filter) {
  const ands = filter?.$and || [];
  for (const c of ands) {
    if (!c || typeof c !== 'object') continue;
    if (Array.isArray(c.$or) && c.$or.length >= 2) return c;
  }
  return null;
}

function applyTranslationReadyFilter(items, filter, lang) {
  const desired = String(lang || '').trim().toLowerCase();
  const orClause = extractHiEnFeedOrFilter(filter);
  if (!orClause) return items;

  return items.filter((doc) => {
    if (!doc) return false;

    const isOriginalInLang =
      String(doc.originalLang || '').toLowerCase() === desired ||
      (!doc.originalLang && (String(doc.lang || '').toLowerCase() === desired || String(doc.language || '').toLowerCase() === desired));

    const t = doc.translations && doc.translations[desired] ? doc.translations[desired] : null;
    const hasFullBucket = Boolean(t && String(t.title || '').trim() && String(t.summary || '').trim() && String(t.content || '').trim());
    const isReady = doc.translationStatus && doc.translationStatus[desired] === 'ready';

    const isReadyTranslated = Boolean(isReady && hasFullBucket);
    return isOriginalInLang || isReadyTranslated;
  });
}

function containsLangKeys(expr) {
  if (!expr || typeof expr !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(expr, 'lang') || Object.prototype.hasOwnProperty.call(expr, 'language')) return true;
  if (Array.isArray(expr.$or)) return expr.$or.some(containsLangKeys);
  if (Array.isArray(expr.$and)) return expr.$and.some(containsLangKeys);
  return false;
}

function matchesExpression(doc, expr) {
  if (!expr || typeof expr !== 'object') return true;
  if (Array.isArray(expr.$or)) return expr.$or.some((e) => matchesExpression(doc, e));
  if (Array.isArray(expr.$and)) return expr.$and.every((e) => matchesExpression(doc, e));
  return matchesClause(doc, expr);
}

function matchesClause(doc, clause) {
  const keys = Object.keys(clause || {});
  if (!keys.length) return true;
  for (const k of keys) {
    const v = clause[k];
    const actual = doc ? doc[k] : undefined;
    if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, '$exists')) {
      const exists = Object.prototype.hasOwnProperty.call(doc, k);
      if (Boolean(v.$exists) !== exists) return false;
    } else if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, '$in')) {
      const arr = Array.isArray(v.$in) ? v.$in : [];
      if (!arr.includes(actual)) return false;
    } else if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, '$regex')) {
      const rx = v.$regex instanceof RegExp
        ? v.$regex
        : new RegExp(String(v.$regex || ''), String(v.$options || ''));
      if (!rx.test(String(actual ?? ''))) return false;
    } else if (v === null) {
      if (actual !== null && actual !== undefined) return false;
    } else {
      if (actual !== v) return false;
    }
  }
  return true;
}

function applyLangFilter(items, filter) {
  const langCond = extractLangFilter(filter);
  if (!langCond) return items;
  const ors = (langCond.$or || []).filter(containsLangKeys);
  if (!ors.length) return items;
  return items.filter((doc) => ors.some((cl) => matchesExpression(doc, cl)));
}

test('Model default lang is en when omitted', () => {
  const doc = new News({ title: 't', description: 'd' });
  assert.equal(doc.lang, 'en');
  assert.equal(doc.language, 'en');
});

test('GET /api/public/news supports lang=en and returns feed shape', async () => {
  const res = await request(app).get('/api/public/news?category=national&lang=en&limit=5');
  assert.equal(res.status, 200);
  assert.ok(res.body);
  assert.ok(Array.isArray(res.body.items));
  assert.equal(typeof res.body.page, 'number');
  assert.equal(typeof res.body.limit, 'number');
  assert.equal(typeof res.body.total, 'number');
  assert.equal(typeof res.body.totalPages, 'number');
});

test('GET /api/public/news defaults to strict Gujarati-published results and includes safe route metadata', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFind = News.find;
  const prevCount = News.countDocuments;

  try {
    mongoose.connection.readyState = 1;

    const dataset = [
      {
        _id: '507f1f77bcf86cd799439031',
        title: 'English base',
        description: 'Base summary',
        content: 'Base content',
        slug: 'english-base',
        slugs: { en: 'english-base', gu: 'gujarati-localized' },
        lang: 'en',
        originalLang: 'en',
        status: 'published',
        translations: {
          gu: { title: 'ગુજરાતી શીર્ષક', summary: 'ગુજરાતી સારાંશ', content: 'ગુજરાતી વિગતો' },
        },
        translationStatus: { gu: 'ready' },
      },
    ];

    let lastFilter = null;
    News.find = (filter) => {
      lastFilter = filter;
      return makeChainableQuery(dataset);
    };
    News.countDocuments = async (filter) => {
      lastFilter = filter;
      return dataset.length;
    };

    const res = await request(app).get('/api/public/news?category=business&limit=10');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.equal(res.body.items.length, 1);

    const langCond = extractLangFilter(lastFilter);
    assert.ok(langCond, 'expected a strict Gujarati-ready eligibility filter');
    assert.ok(containsTranslationReady(lastFilter, 'gu'), 'expected Gujarati feed to require ready translations when fallback is disabled');

    const localized = res.body.items.find((item) => item.canonicalSlug === 'gujarati-localized');
    assert.ok(localized, 'expected Gujarati-localized slug to be returned');
    assert.equal(localized.title, 'ગુજરાતી શીર્ષક');
    assert.equal(localized.description, 'ગુજરાતી સારાંશ');
    assert.equal(localized.content, 'ગુજરાતી વિગતો');
    assert.equal(localized.requestedLang, 'gu');
    assert.equal(localized.resolvedLang, 'gu');
    assert.equal(localized.locale, 'gu');
    assert.equal(typeof localized.articleId, 'string');
    assert.deepEqual(localized.publishedLocales.sort(), ['en', 'gu']);
    assert.equal(localized.translationAvailability.requestedLocalePublished, true);
    assert.equal(localized.canonicalDetailUrl, '/gu/news/gujarati-localized');
    assert.equal(localized.detailApiUrl, '/api/public/news/gujarati-localized?lang=gu');
  } finally {
    News.find = prevFind;
    News.countDocuments = prevCount;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news allows Gujarati fallback only when explicitly enabled', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFind = News.find;
  const prevCount = News.countDocuments;

  try {
    mongoose.connection.readyState = 1;

    const dataset = [
      {
        _id: '507f1f77bcf86cd799439030',
        title: 'English fallback',
        description: 'Fallback summary',
        content: 'Fallback content',
        slug: 'english-fallback',
        slugs: { en: 'english-fallback', gu: 'gu-fallback-slug' },
        lang: 'en',
        originalLang: 'en',
        status: 'published',
        translations: {},
        translationStatus: {},
      },
    ];

    News.find = () => makeChainableQuery(dataset);
    News.countDocuments = async () => dataset.length;

    const res = await request(app).get('/api/public/news?lang=gu&fallback=true&limit=10');
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].title, 'English fallback');
    assert.equal(res.body.items[0].resolvedLang, 'en');
    assert.equal(res.body.items[0].translationAvailability.requestedLocalePublished, false);
    assert.equal(res.body.items[0].canonicalSlug, 'english-fallback');
    assert.equal(res.body.items[0].canonicalDetailUrl, '/news/english-fallback');
    assert.equal(res.body.items[0].detailApiUrl, '/api/public/news/gu-fallback-slug?lang=gu&fallback=true');
  } finally {
    News.find = prevFind;
    News.countDocuments = prevCount;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news returns hi when lang=hi', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFind = News.find;
  const prevCount = News.countDocuments;

  try {
    mongoose.connection.readyState = 1;

    const dataset = [
      { title: 'gu story', description: 'd', lang: 'gu', status: 'published', translationStatus: { hi: 'pending' } },
      { title: 'hi original', description: 'd', originalLang: 'hi', lang: 'hi', status: 'published', translationStatus: { hi: 'pending' } },
      {
        title: 'gu with hi translation',
        description: 'd',
        originalLang: 'gu',
        lang: 'gu',
        status: 'published',
        translationStatus: { hi: 'ready' },
        translations: { hi: { title: 'hi t', summary: 'hi s', content: 'hi c' } },
      },
      { title: 'missing lang', description: 'd', status: 'published', translationStatus: {} },
    ];

    let lastFilter = null;
    News.find = (filter) => {
      lastFilter = filter;
      return makeChainableQuery(applyTranslationReadyFilter(dataset, filter, 'hi'));
    };
    News.countDocuments = async (filter) => {
      lastFilter = filter;
      return applyTranslationReadyFilter(dataset, filter, 'hi').length;
    };

    const res = await request(app).get('/api/public/news?lang=hi&limit=10');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));

    const orCond = extractHiEnFeedOrFilter(lastFilter);
    assert.ok(orCond, 'expected an $or filter for hi feed to be present');
    assert.ok(containsTranslationReady(lastFilter, 'hi'), 'expected translation readiness to be referenced in filter');

    // With our stubbed data, both the original-Hindi doc and the translated doc are eligible.
    assert.equal(res.body.items.length, 2);
    assert.ok(res.body.items.every((it) => it.lang === 'hi'));
    assert.ok(res.body.items.some((it) => it.title === 'hi original'));
    assert.ok(res.body.items.some((it) => it.title === 'hi t'));
  } finally {
    News.find = prevFind;
    News.countDocuments = prevCount;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/news supports lang=hi and returns feed shape', async () => {
  const res = await request(app).get('/api/public/news?category=national&lang=hi&limit=5');
  assert.equal(res.status, 200);
  assert.ok(res.body);
  assert.ok(Array.isArray(res.body.items));
});

test('GET /api/public/news supports q + lang and returns feed shape', async () => {
  const res = await request(app).get('/api/public/news?q=budget&lang=en&limit=5');
  assert.equal(res.status, 200);
  assert.ok(res.body);
  assert.ok(Array.isArray(res.body.items));
});

test('GET /api/public/news/translations/:translationGroupId returns 200 and an array', async () => {
  const res = await request(app).get('/api/public/news/translations/test-group');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});
