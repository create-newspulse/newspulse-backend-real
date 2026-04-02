const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');

function restore(originals) {
  for (const [k, v] of Object.entries(originals)) News[k] = v;
}

test('GET /api/public/articles honors x-lang header and localizes from cached translations', async () => {
  const originals = { find: News.find, countDocuments: News.countDocuments };
  try {
    const doc = {
      _id: '507f1f77bcf86cd799439099',
      status: 'published',
      category: 'national',
      language: 'gu',
      originalLang: 'gu',
      title: 'હેલો',
      description: 'સારાંશ',
      content: '<p>શરીર</p>',
      translations: {
        hi: { title: 'नमस्ते', summary: 'सारांश', content: '<p>शरीर</p>' },
      },
      translationStatus: {
        hi: 'ready',
      },
      publishedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    News.find = (_query) => ({
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      lean: async () => [doc],
    });

    News.countDocuments = async () => 1;

    const res = await request(app)
      .get('/api/public/articles?limit=1&page=1')
      .set('x-lang', 'hi');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data && Array.isArray(res.body.data.items), true);
    assert.equal(res.body.data.items.length, 1);

    const out = res.body.data.items[0];
    assert.equal(out.title, 'नमस्ते');
    assert.equal(out.description, 'सारांश');
    assert.equal(out.summary, 'सारांश');
    assert.equal(out.content, '<p>शरीर</p>');
    assert.equal(out.language, 'hi');
  } finally {
    restore(originals);
  }
});

test('GET /api/public/articles?lang=gu localizes Gujarati fields and falls back to base values', async () => {
  const originals = { find: News.find, countDocuments: News.countDocuments };
  try {
    const docs = [
      {
        _id: '507f1f77bcf86cd799439101',
        status: 'published',
        category: 'national',
        language: 'en',
        originalLang: 'en',
        slug: 'base-english',
        slugs: { en: 'base-english', gu: 'gujarati-article' },
        title: 'Base English',
        description: 'Base summary',
        content: '<p>Base body</p>',
        translations: {
          gu: { title: 'ગુજરાતી લેખ', summary: 'ગુજરાતી સાર', content: '<p>ગુજરાતી બોડી</p>' },
        },
        translationStatus: {
          gu: 'ready',
        },
        publishedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      {
        _id: '507f1f77bcf86cd799439102',
        status: 'published',
        category: 'national',
        language: 'en',
        originalLang: 'en',
        slug: 'base-fallback',
        slugs: { en: 'base-fallback' },
        title: 'Fallback English',
        description: 'Fallback summary',
        content: '<p>Fallback body</p>',
        translations: {},
        translationStatus: {},
        publishedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ];

    News.find = (_query) => ({
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      lean: async () => docs,
    });

    News.countDocuments = async () => docs.length;

    const res = await request(app).get('/api/public/articles?limit=10&page=1&lang=gu');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.items.length, 2);

    const localized = res.body.data.items.find((item) => item.canonicalSlug === 'gujarati-article');
    assert.ok(localized);
    assert.equal(localized.title, 'ગુજરાતી લેખ');
    assert.equal(localized.description, 'ગુજરાતી સાર');
    assert.equal(localized.summary, 'ગુજરાતી સાર');
    assert.equal(localized.content, '<p>ગુજરાતી બોડી</p>');
    assert.equal(localized.requestedLang, 'gu');
    assert.equal(localized.resolvedLang, 'gu');

    const fallback = res.body.data.items.find((item) => item.slug === 'base-fallback');
    assert.ok(fallback);
    assert.equal(fallback.title, 'Fallback English');
    assert.equal(fallback.description, 'Fallback summary');
    assert.equal(fallback.requestedLang, 'gu');
    assert.equal(fallback.resolvedLang, 'en');
  } finally {
    restore(originals);
  }
});

test('GET /api/articles/by-slug/:slug?lang=gu falls back to base content and returns Gujarati canonical slug', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findOne: News.findOne };
  try {
    mongoose.connection.readyState = 1;

    const doc = {
      _id: '507f1f77bcf86cd799439103',
      status: 'published',
      category: 'national',
      language: 'en',
      originalLang: 'en',
      slug: 'base-detail-slug',
      slugs: { en: 'base-detail-slug', gu: 'gu-detail-slug' },
      title: 'Detail English',
      description: 'Detail summary',
      content: '<p>Detail body</p>',
      translations: {},
      translationStatus: {},
      publishedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    News.findOne = () => ({
      lean: async () => doc,
      catch() { return this; },
    });

    const res = await request(app).get('/api/articles/by-slug/base-detail-slug?lang=gu');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.title, 'Detail English');
    assert.equal(res.body.requestedLang, 'gu');
    assert.equal(res.body.resolvedLang, 'en');
    assert.equal(res.body.slug, 'gu-detail-slug');
    assert.equal(res.body.canonicalSlug, 'gu-detail-slug');
    assert.equal(res.body.localizedSlug, 'gu-detail-slug');
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/articles/by-slug/:slug infers Gujarati locale from localized slug when lang is omitted', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findOne: News.findOne };
  try {
    mongoose.connection.readyState = 1;

    const doc = {
      _id: '507f1f77bcf86cd799439104',
      status: 'published',
      category: 'national',
      language: 'en',
      originalLang: 'en',
      slug: 'base-detail-slug-implicit',
      slugs: { en: 'base-detail-slug-implicit', gu: 'gu-detail-slug-implicit' },
      title: 'Detail English implicit',
      description: 'Detail summary implicit',
      content: '<p>Detail body implicit</p>',
      translations: {},
      translationStatus: {},
      publishedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    News.findOne = () => ({
      lean: async () => doc,
      catch() { return this; },
    });

    const res = await request(app).get('/api/articles/by-slug/gu-detail-slug-implicit');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.requestedLang, 'gu');
    assert.equal(res.body.resolvedLang, 'en');
    assert.equal(res.body.slug, 'gu-detail-slug-implicit');
    assert.equal(res.body.canonicalSlug, 'gu-detail-slug-implicit');
    assert.equal(res.body.localizedSlug, 'gu-detail-slug-implicit');
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});
