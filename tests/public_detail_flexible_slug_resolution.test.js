const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');

function restore(NewsModel, originals) {
  for (const [k, v] of Object.entries(originals)) NewsModel[k] = v;
}

function makeLeanQuery(doc) {
  return {
    select() { return this; },
    sort() { return this; },
    lean: async () => doc,
  };
}

test('GET /api/public/news/slug/:slug resolves group by any slug but returns requested EN variant', async () => {
  const originals = { findOne: News.findOne };
  const prevReadyState = mongoose.connection.readyState;

  try {
    mongoose.connection.readyState = 1;

    const guSlug = 'ગુજરાતી-સ્લગ';
    const doc = {
      _id: '507f1f77bcf86cd799439031',
      status: 'published',
      category: 'national',
      slug: guSlug,
      slugs: { gu: guSlug, en: 'english-slug' },
      originalLang: 'gu',
      lang: 'gu',
      language: 'gu',
      title: 'મૂળ શીર્ષક',
      description: 'મૂળ સારાંશ',
      content: '<p>મૂળ સામગ્રી</p>',
      translationStatus: { en: 'ready' },
      translations: {
        en: {
          title: 'English title',
          summary: 'English summary',
          content: '<p>English content</p>',
        },
      },
      publishedAt: new Date('2026-03-25T00:00:00.000Z'),
      createdAt: new Date('2026-03-25T00:00:00.000Z'),
      updatedAt: new Date('2026-03-25T00:00:00.000Z'),
    };

    News.findOne = () => makeLeanQuery(doc);

    const res = await request(app).get(`/api/public/news/slug/${encodeURIComponent(guSlug)}`);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.title, 'English title');
    assert.equal(res.body.summary, 'English summary');
    assert.equal(res.body.content, '<p>English content</p>');
    assert.equal(res.body.locale, 'en');
    assert.equal(res.body.resolvedLang, 'en');
    assert.ok(res.body.storyGroupId);
  } finally {
    restore(News, originals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/news/slug/:slug (compat) returns requested EN variant for Gujarati slug', async () => {
  const originals = { findOne: News.findOne };
  const prevReadyState = mongoose.connection.readyState;

  try {
    mongoose.connection.readyState = 1;

    const guSlug = 'ગુજરાતી-સ્લગ-2';
    const doc = {
      _id: '507f1f77bcf86cd799439032',
      status: 'published',
      category: 'national',
      slug: guSlug,
      slugs: { gu: guSlug, en: 'english-slug-2' },
      originalLang: 'gu',
      lang: 'gu',
      language: 'gu',
      title: 'ગુજરાતી ટાઇટલ',
      description: 'ગુજરાતી સારાંશ',
      content: '<p>ગુજરાતી કન્ટેન્ટ</p>',
      translationStatus: { en: 'ready' },
      translations: {
        en: {
          title: 'English title 2',
          summary: 'English summary 2',
          content: '<p>English content 2</p>',
        },
      },
    };

    // This endpoint calls findOne(...).lean() directly.
    News.findOne = () => ({ lean: async () => doc });

    const res = await request(app).get(`/api/news/slug/${encodeURIComponent(guSlug)}`);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.title, 'English title 2');
    assert.equal(res.body.data.summary, 'English summary 2');
    assert.equal(res.body.data.content, '<p>English content 2</p>');
    assert.equal(res.body.data.locale, 'en');
    assert.equal(res.body.data.resolvedLang, 'en');
    assert.ok(res.body.data.storyGroupId);
  } finally {
    restore(News, originals);
    mongoose.connection.readyState = prevReadyState;
  }
});
