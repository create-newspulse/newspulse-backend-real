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
        slugs: { en: 'english-slug', hi: unicodeSlug, gu: 'gujarati-slug' },
        lang: 'en',
        language: 'en',
        category: 'national',
        status: 'published',
      });
    };

    const res = await request(app).get(`/api/public/news/slug/${encoded}?lang=EN`);
    assert.equal(res.status, 200);
    assert.equal(res.body.slug, unicodeSlug);
    assert.equal(res.body.canonicalSlug, 'english-slug');

    assert.ok(calls.length >= 1, 'expected at least one News.findOne call');
    const first = calls[0];

    // Ensure we include raw (percent-encoded) and decoded candidates.
    const ands = first.$and || [];
    const slugCond = ands.find((c) => Array.isArray(c?.$or) && c.$or.some((x) => x?.slug || x?.['slugs.en'] || x?.['slugs.hi'] || x?.['slugs.gu']));
    assert.ok(slugCond, 'expected a slug lookup condition');

    const slugOr = slugCond.$or || [];
    const values = [];
    for (const clause of slugOr) {
      const v = clause.slug ?? clause['slugs.en'] ?? clause['slugs.hi'] ?? clause['slugs.gu'];
      if (!v) continue;
      if (typeof v === 'object' && Array.isArray(v.$in)) values.push(...v.$in);
      else values.push(String(v));
    }

    assert.ok(values.includes(encoded), 'expected raw encoded slug candidate');
    assert.ok(values.includes(unicodeSlug), 'expected decoded unicode slug candidate');

    // Ensure lang filter was applied case-safely via $in.
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
