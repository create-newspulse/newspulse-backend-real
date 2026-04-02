const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');
const Article = require('../models/Article');

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function matchesClause(doc, clause) {
  if (!clause || typeof clause !== 'object') return true;

  if (Array.isArray(clause.$and)) return clause.$and.every((entry) => matchesClause(doc, entry));
  if (Array.isArray(clause.$or)) return clause.$or.some((entry) => matchesClause(doc, entry));

  return Object.entries(clause).every(([key, expected]) => {
    if (key === '$and' || key === '$or') return true;

    const actual = getPath(doc, key);
    if (expected instanceof RegExp) {
      if (Array.isArray(actual)) return actual.some((entry) => expected.test(String(entry || '')));
      return expected.test(String(actual || ''));
    }

    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, '$regex')) {
        const rx = new RegExp(expected.$regex, expected.$options || '');
        return rx.test(String(actual || ''));
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$in')) {
        return expected.$in.includes(actual);
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
        return expected.$exists ? actual !== undefined : actual === undefined;
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$ne')) {
        return actual !== expected.$ne;
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$lte')) {
        return actual === null || actual === undefined || new Date(actual).getTime() <= new Date(expected.$lte).getTime();
      }
      return matchesClause(actual || {}, expected);
    }

    if (Array.isArray(actual)) return actual.includes(expected);
    return actual === expected;
  });
}

function makeNewsQuery(items) {
  return {
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => items,
  };
}

function makeArticleQuery(items) {
  return {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => items,
  };
}

test('GET /api/public/news filters Youth Pulse by track=student-voices', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { find: News.find, countDocuments: News.countDocuments };

  try {
    mongoose.connection.readyState = 1;

    const docs = [
      {
        _id: 'n1',
        title: 'Student Voices story',
        description: 'd',
        content: 'c',
        slug: 'student-voices-story',
        category: 'youth-pulse',
        track: 'student-voices',
        tags: ['track:student-voices'],
        status: 'published',
        lang: 'en',
        language: 'en',
        originalLang: 'en',
        publishedAt: new Date('2026-04-03T10:00:00.000Z'),
        createdAt: new Date('2026-04-03T10:00:00.000Z'),
      },
      {
        _id: 'n2',
        title: 'Campus Buzz story',
        description: 'd',
        content: 'c',
        slug: 'campus-buzz-story',
        category: 'youth-pulse',
        track: 'campus-buzz',
        tags: ['track:campus-buzz'],
        status: 'published',
        lang: 'en',
        language: 'en',
        originalLang: 'en',
        publishedAt: new Date('2026-04-03T09:00:00.000Z'),
        createdAt: new Date('2026-04-03T09:00:00.000Z'),
      },
    ];

    News.find = (filter) => makeNewsQuery(docs.filter((doc) => matchesClause(doc, filter)));
    News.countDocuments = async (filter) => docs.filter((doc) => matchesClause(doc, filter)).length;

    const res = await request(app).get('/api/public/news?category=youth-pulse&track=student-voices&lang=en&limit=10');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].slug, 'student-voices-story');
    assert.equal(res.body.items[0].track, 'student-voices');
  } finally {
    News.find = originals.find;
    News.countDocuments = originals.countDocuments;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/public/stories filters Youth Pulse public articles by track=student-voices', async () => {
  const originals = { find: Article.find };

  try {
    const docs = [
      {
        _id: 'a1',
        title: 'Student Voices article',
        summary: 'd',
        content: 'c',
        slug: 'student-voices-article',
        category: 'youth-pulse',
        track: 'student-voices',
        tags: ['track:student-voices'],
        status: 'published',
        language: 'en',
        originalLang: 'en',
      },
      {
        _id: 'a2',
        title: 'Youth Pulse general article',
        summary: 'd',
        content: 'c',
        slug: 'youth-pulse-general',
        category: 'youth-pulse',
        track: 'young-achievers',
        tags: ['track:young-achievers'],
        status: 'published',
        language: 'en',
        originalLang: 'en',
      },
    ];

    Article.find = (filter) => makeArticleQuery(docs.filter((doc) => matchesClause(doc, filter)));

    const res = await request(app).get('/api/public/stories?category=youth-pulse&track=student-voices&limit=10&page=1');

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].slug, 'student-voices-article');
    assert.equal(res.body.data[0].track, 'student-voices');
  } finally {
    Article.find = originals.find;
  }
});