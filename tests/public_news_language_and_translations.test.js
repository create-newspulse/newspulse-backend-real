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
    if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, '$exists')) {
      const exists = Object.prototype.hasOwnProperty.call(doc, k);
      if (Boolean(v.$exists) !== exists) return false;
    } else if (v === null) {
      if (doc[k] !== null && doc[k] !== undefined) return false;
    } else {
      if (doc[k] !== v) return false;
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

test('Model default lang is gu when omitted', () => {
  const doc = new News({ title: 't', description: 'd' });
  assert.equal(doc.lang, 'gu');
  assert.equal(doc.language, 'gu');
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

test('GET /api/public/news returns only gu by default (no lang param)', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFind = News.find;
  const prevCount = News.countDocuments;

  try {
    mongoose.connection.readyState = 1;

    const dataset = [
      { title: 'gu story', description: 'd', lang: 'gu', status: 'published' },
      { title: 'hi story', description: 'd', lang: 'hi', status: 'published' },
      { title: 'missing lang', description: 'd', status: 'published' },
    ];

    let lastFilter = null;
    News.find = (filter) => {
      lastFilter = filter;
      return makeChainableQuery(applyLangFilter(dataset, filter));
    };
    News.countDocuments = async (filter) => {
      lastFilter = filter;
      return applyLangFilter(dataset, filter).length;
    };

    const res = await request(app).get('/api/public/news?category=business&limit=10');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));

    // Ensure the controller applied a default Gujarati filter.
    const langCond = extractLangFilter(lastFilter);
    assert.ok(langCond, 'expected a lang filter to be present');

    // Ensure results are normalized to gu and do not include hi.
    for (const item of res.body.items) {
      assert.equal(item.lang, 'gu');
    }
    assert.ok(res.body.items.every((i) => i.title !== 'hi story'));
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
      { title: 'gu story', description: 'd', lang: 'gu', status: 'published' },
      { title: 'hi story', description: 'd', lang: 'hi', status: 'published' },
      { title: 'missing lang', description: 'd', status: 'published' },
    ];

    let lastFilter = null;
    News.find = (filter) => {
      lastFilter = filter;
      return makeChainableQuery(applyLangFilter(dataset, filter));
    };
    News.countDocuments = async (filter) => {
      lastFilter = filter;
      return applyLangFilter(dataset, filter).length;
    };

    const res = await request(app).get('/api/public/news?lang=hi&limit=10');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));

    const langCond = extractLangFilter(lastFilter);
    assert.ok(langCond, 'expected a lang filter to be present');

    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].lang, 'hi');
    assert.equal(res.body.items[0].title, 'hi story');
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
