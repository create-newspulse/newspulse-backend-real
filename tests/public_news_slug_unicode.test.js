const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');
const mongoose = require('mongoose');
const News = require('../models/News');

function makeFindOneResult(doc, capture) {
  return {
    select() { return this; },
    sort() { return this; },
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
        slugs: { en: 'english-slug', hi: unicodeSlug, gu: 'gujarati-slug' },
        lang: 'hi',
        language: 'hi',
        originalLang: 'hi',
        category: 'national',
        status: 'published',
      });
    };

    const res = await request(app).get(`/api/public/news/slug/${encoded}?lang=HI`);
    assert.equal(res.status, 200);
    assert.equal(res.body.slug, unicodeSlug);
    assert.equal(res.body.canonicalSlug, unicodeSlug);

    assert.ok(calls.length >= 1, 'expected at least one News.findOne call');
    const first = calls[0];

    // Ensure we include raw (percent-encoded) and decoded candidates.
    const ands = first.$and || [];
    const slugCond = ands.find((c) => Array.isArray(c?.$or) && c.$or.some((x) => x?.slug || x?.['slugs.hi']));
    assert.ok(slugCond, 'expected a slug lookup condition');

    const slugOr = slugCond.$or || [];
    const values = [];
    for (const clause of slugOr) {
      assert.ok(!clause['slugs.en'], 'expected strict locale slug lookup (no slugs.en)');
      assert.ok(!clause['slugs.gu'], 'expected strict locale slug lookup (no slugs.gu)');

      const v = clause.slug ?? clause['slugs.hi'];
      if (!v) continue;
      if (typeof v === 'object' && Array.isArray(v.$in)) values.push(...v.$in);
      else values.push(String(v));
    }

    assert.ok(values.includes(encoded), 'expected raw encoded slug candidate');
    assert.ok(values.includes(unicodeSlug), 'expected decoded unicode slug candidate');

    // Case-safety: the request with lang=EN should succeed (asserted above).
  } finally {
    News.findOne = prevFindOne;
    mongoose.connection.readyState = prevReadyState;
  }
});
