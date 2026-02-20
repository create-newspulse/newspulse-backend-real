const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');
const mongoose = require('mongoose');
const News = require('../models/News');

function makeFindOneResult(doc, capture) {
  return {
    select() { return this; },
    lean: async () => {
      if (typeof capture === 'function') capture();
      return doc;
    },
  };
}

test('GET /api/public/news/slug/:slug is unicode-safe and lang filter is case-safe', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFindOne = News.findOne;

  try {
    mongoose.connection.readyState = 1;

    const unicodeSlug = 'हिंदी';
    const encoded = encodeURIComponent(unicodeSlug);

    const calls = [];
    News.findOne = (filter) => {
      calls.push(filter);
      return makeFindOneResult({
        title: 't',
        description: 'd',
        content: 'c',
        slug: unicodeSlug,
        lang: 'en',
        language: 'en',
        category: 'national',
        status: 'published',
      });
    };

    const res = await request(app).get(`/api/public/news/slug/${encoded}?lang=EN`);
    assert.equal(res.status, 200);
    assert.equal(res.body.slug, unicodeSlug);

    assert.ok(calls.length >= 1, 'expected at least one News.findOne call');
    const first = calls[0];

    // Ensure we include raw (percent-encoded) and decoded candidates.
    const slugExpr = first.slug;
    const inList = slugExpr && typeof slugExpr === 'object' && Array.isArray(slugExpr.$in) ? slugExpr.$in : [];
    assert.ok(inList.includes(encoded) || String(slugExpr) === encoded, 'expected raw encoded slug candidate');
    assert.ok(inList.includes(unicodeSlug) || String(slugExpr) === unicodeSlug, 'expected decoded unicode slug candidate');

    // Ensure lang filter was applied case-safely via $in.
    const ands = first.$and || [];
    const langCond = ands.find((c) => Array.isArray(c?.$or) && c.$or.some((x) => x?.lang || x?.language));
    assert.ok(langCond, 'expected a lang filter condition');

    const langOr = langCond.$or.find((x) => x.lang);
    assert.ok(langOr && langOr.lang && Array.isArray(langOr.lang.$in), 'expected $in lang clause');
    assert.ok(langOr.lang.$in.includes('en'));
    assert.ok(langOr.lang.$in.includes('EN'));
  } finally {
    News.findOne = prevFindOne;
    mongoose.connection.readyState = prevReadyState;
  }
});
