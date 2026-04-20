const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

const News = require('../models/News');

process.env.NODE_ENV = 'test';

const app = require('../server');

function makeFindResult(items) {
  const rows = Array.isArray(items) ? [...items] : [];
  return {
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => rows,
  };
}

function makeFindOneResult(item) {
  return {
    select() { return this; },
    sort() { return this; },
    lean: async () => item,
  };
}

function withDbReady(fn) {
  return async () => {
    const descriptor = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 1,
    });

    try {
      await fn();
    } finally {
      if (descriptor) {
        Object.defineProperty(mongoose.connection, 'readyState', descriptor);
      } else {
        delete mongoose.connection.readyState;
      }
    }
  };
}

test('GET /api/breaking returns mobile-friendly breaking feed JSON', { concurrency: false }, withDbReady(async () => {
  const prevFind = News.find;
  const prevCountDocuments = News.countDocuments;

  try {
    News.find = () => makeFindResult([
      {
        _id: '507f1f77bcf86cd799439211',
        title: 'તાજી બ્રેકિંગ હેડલાઇન',
        description: 'બ્રેકિંગ ફીડ માટે ટૂંકું વર્ણન',
        content: '<p>આ સંપૂર્ણ બ્રેકિંગ સ્ટોરી છે.</p>',
        slug: 'tajee-breaking-headline',
        slugs: { gu: 'tajee-breaking-headline' },
        category: 'breaking',
        status: 'published',
        lang: 'gu',
        language: 'gu',
        originalLang: 'gu',
        coverImageUrl: 'https://img.example/breaking.jpg',
        publishedAt: new Date('2026-04-20T09:00:00.000Z').toISOString(),
        updatedAt: new Date('2026-04-20T09:15:00.000Z').toISOString(),
      },
    ]);
    News.countDocuments = async () => 1;

    const res = await request(app).get('/api/breaking?lang=gu');

    assert.equal(res.status, 200);
    assert.equal(Array.isArray(res.body.items), true);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].id, '507f1f77bcf86cd799439211');
    assert.equal(res.body.items[0].slug, 'tajee-breaking-headline');
    assert.equal(res.body.items[0].summary, 'બ્રેકિંગ ફીડ માટે ટૂંકું વર્ણન');
    assert.equal(res.body.items[0].imageUrl, 'https://img.example/breaking.jpg');
    assert.equal(typeof res.body.items[0].readMinutes, 'number');
  } finally {
    News.find = prevFind;
    News.countDocuments = prevCountDocuments;
  }
}));

test('GET /api/public/news supports q search and returns mobile-safe feed fields', { concurrency: false }, withDbReady(async () => {
  const prevFind = News.find;
  const prevCountDocuments = News.countDocuments;

  try {
    News.find = () => makeFindResult([
      {
        _id: '507f1f77bcf86cd799439212',
        title: 'Budget desk update',
        description: 'Searchable summary for the budget story',
        content: '<p>Budget story body for search results.</p>',
        slug: 'budget-desk-update',
        slugs: { en: 'budget-desk-update' },
        category: 'national',
        status: 'published',
        lang: 'en',
        language: 'en',
        originalLang: 'en',
        publishedAt: new Date('2026-04-20T07:00:00.000Z').toISOString(),
        updatedAt: new Date('2026-04-20T07:05:00.000Z').toISOString(),
      },
    ]);
    News.countDocuments = async () => 1;

    const res = await request(app).get('/api/public/news?q=budget&lang=en');

    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.items[0].id, '507f1f77bcf86cd799439212');
    assert.equal(res.body.items[0].excerpt, 'Searchable summary for the budget story');
    assert.equal(res.body.items[0].language, 'en');
    assert.equal(typeof res.body.items[0].detailApiUrl, 'string');
  } finally {
    News.find = prevFind;
    News.countDocuments = prevCountDocuments;
  }
}));

test('GET /api/public/news/:slugOrId returns body and mobile detail fields', { concurrency: false }, withDbReady(async () => {
  const prevFindOne = News.findOne;

  try {
    News.findOne = () => makeFindOneResult({
      _id: '507f1f77bcf86cd799439213',
      title: 'Detail page story',
      description: 'Detail summary',
      content: '<p>This is the full story body for detail rendering.</p>',
      slug: 'detail-page-story',
      slugs: { en: 'detail-page-story' },
      category: 'world',
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      coverImageUrl: 'https://img.example/detail.jpg',
      publishedAt: new Date('2026-04-20T06:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-04-20T06:30:00.000Z').toISOString(),
      translations: {},
      translationStatus: {},
    });

    const res = await request(app).get('/api/public/news/detail-page-story?lang=en');

    assert.equal(res.status, 200);
    assert.equal(res.body.id, '507f1f77bcf86cd799439213');
    assert.equal(res.body.slug, 'detail-page-story');
    assert.equal(res.body.body, '<p>This is the full story body for detail rendering.</p>');
    assert.equal(res.body.summary, 'Detail summary');
    assert.equal(typeof res.body.readMinutes, 'number');
  } finally {
    News.findOne = prevFindOne;
  }
}));