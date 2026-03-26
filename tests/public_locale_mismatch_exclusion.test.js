const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');
const Article = require('../models/Article');

function restore(Model, originals) {
  for (const [k, v] of Object.entries(originals)) Model[k] = v;
}

function makeLeanQuery(doc) {
  return {
    select() { return this; },
    sort() { return this; },
    lean: async () => doc,
  };
}

function makeLeanQueryWithSort(doc) {
  return {
    sort() { return this; },
    lean: async () => doc,
  };
}

const GU_TITLE = 'ગુજરાતી ભાષા શીર્ષક ટેસ્ટ';
const GU_SUMMARY = 'ગુજરાતી સારાંશ ગુજરાતી સારાંશ';
const GU_CONTENT = '<p>ગુજરાતી સામગ્રી ગુજરાતી સામગ્રી ગુજરાતી સામગ્રી</p>';

test('Public News EN excludes Gujarati-in-EN translation bucket (returns 404)', async () => {
  const originals = { findOne: News.findOne };
  const prevReadyState = mongoose.connection.readyState;

  try {
    // publicNewsController uses connection.readyState; force it to appear connected.
    mongoose.connection.readyState = 1;

    const guSlug = 'gujarati-slug-for-mismatch-test';
    const doc = {
      _id: '507f1f77bcf86cd799439041',
      status: 'published',
      category: 'national',
      slug: guSlug,
      slugs: { gu: guSlug, en: 'english-slug-should-not-be-used' },
      originalLang: 'gu',
      lang: 'gu',
      language: 'gu',
      title: GU_TITLE,
      description: GU_SUMMARY,
      content: GU_CONTENT,
      translationStatus: { en: 'ready' },
      translations: {
        // Corrupted: Gujarati text stored under the EN bucket.
        en: {
          title: GU_TITLE,
          summary: GU_SUMMARY,
          content: GU_CONTENT,
        },
      },
      publishedAt: new Date('2026-03-25T00:00:00.000Z'),
      createdAt: new Date('2026-03-25T00:00:00.000Z'),
      updatedAt: new Date('2026-03-25T00:00:00.000Z'),
    };

    News.findOne = () => makeLeanQuery(doc);

    const res = await request(app).get(`/api/public/news/slug/${encodeURIComponent(guSlug)}`);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body?.message, 'Not found');
  } finally {
    restore(News, originals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('Public Stories EN excludes Gujarati-in-EN i18n bucket (returns LOCALE_NOT_AVAILABLE)', async () => {
  const originals = { findOne: Article.findOne };

  try {
    const slug = 'story-slug-mismatch-test';
    const storyDoc = {
      _id: '507f1f77bcf86cd799439051',
      status: 'published',
      slug,
      slugs: { gu: slug, en: 'en-slug' },
      originalLang: 'gu',
      lang: 'gu',
      language: 'gu',
      // i18n cache exists but is corrupted for EN.
      i18n: {
        title: { en: GU_TITLE, gu: GU_TITLE },
        summary: { en: GU_SUMMARY, gu: GU_SUMMARY },
        content: { en: GU_CONTENT, gu: GU_CONTENT },
      },
      publishedAt: new Date('2026-03-25T00:00:00.000Z'),
      createdAt: new Date('2026-03-25T00:00:00.000Z'),
      updatedAt: new Date('2026-03-25T00:00:00.000Z'),
    };

    Article.findOne = () => makeLeanQueryWithSort(storyDoc);

    const res = await request(app).get(`/api/public/stories/${encodeURIComponent(slug)}`);

    assert.equal(res.statusCode, 404);
    assert.equal(res.body?.success, false);
    assert.equal(res.body?.code, 'LOCALE_NOT_AVAILABLE');
    assert.equal(res.body?.requestedLang, 'en');
  } finally {
    restore(Article, originals);
  }
});
