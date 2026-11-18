require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server');
const { installEditorialFixture } = require('./helpers/editorialLifecycleFixture');

test('GET /api/public/news/slug/:slug is unicode-safe and resolves locale after slug lookup', async t => {
    const state = installEditorialFixture(t);
    const unicodeSlug = 'हिंदी';
    const encoded = encodeURIComponent(unicodeSlug);
    state.rows.News.push({
        _id: '507f1f77bcf86cd79943c099',
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

    const res = await request(app).get(`/api/public/news/slug/${encoded}?lang=EN`);
    assert.equal(res.status, 200);
    assert.equal(res.body.slug, unicodeSlug);
    assert.equal(res.body.canonicalSlug, 'english-slug');

    const first = state.calls.find(call => call.name === 'News' && call.method === 'find').filter;

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

    // Detail lookup no longer filters the database by requested lang before resolving the matched article group.
    const langCond = ands.find((c) => Array.isArray(c?.$or) && c.$or.some((x) => x?.lang || x?.language));
    assert.equal(langCond, undefined);
});
