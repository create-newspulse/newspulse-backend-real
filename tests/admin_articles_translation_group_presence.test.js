const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function restore(originals) {
  for (const [k, v] of Object.entries(originals)) News[k] = v;
}

function makeFindByIdResult(doc, asDocument = false) {
  return {
    select() { return this; },
    lean: async () => doc,
    then(resolve) {
      return Promise.resolve(asDocument ? doc : doc).then(resolve);
    },
    catch() { return this; },
  };
}

function makeFindResult(docs) {
  return {
    select() { return this; },
    lean: async () => docs,
  };
}

test('GET /api/admin/articles/:id/translation-status counts source language as present in group metadata', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findById: News.findById, find: News.find };

  try {
    mongoose.connection.readyState = 1;

    const sourceDoc = {
      _id: '507f1f77bcf86cd799439201',
      title: 'English source',
      slug: 'english-source',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      translationKey: 'grp-presence-1',
      translationGroupId: 'grp-presence-1',
      translationStatus: { en: 'ready', hi: 'pending', gu: 'pending' },
      translationError: { en: null, hi: null, gu: null },
      translationUpdatedAt: { en: new Date().toISOString(), hi: null, gu: null },
      translationNextRetryAt: { en: null, hi: null, gu: null },
    };

    const groupDocs = [
      sourceDoc,
      {
        _id: '507f1f77bcf86cd799439202',
        lang: 'hi',
        language: 'hi',
        translationKey: 'grp-presence-1',
        translationGroupId: 'grp-presence-1',
      },
    ];

    News.findById = () => makeFindByIdResult(sourceDoc);
    News.find = () => makeFindResult(groupDocs);

    const token = makeOpaqueAdminToken();
    const res = await request(app)
      .get('/api/admin/articles/507f1f77bcf86cd799439201/translation-status')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.baseLang, 'en');
    assert.deepEqual(res.body.data.languageStates.presentLanguages.sort(), ['en', 'hi']);
    assert.deepEqual(res.body.data.languageStates.missingLanguages, ['gu']);
    assert.equal(res.body.data.languageStates.sourceArticle.id, '507f1f77bcf86cd799439201');
    assert.equal(res.body.data.languageStates.sourceArticle.lang, 'en');
    assert.equal(res.body.data.languageStates.sourceArticle.slug, 'english-source');
    assert.equal(res.body.data.languageStates.sourceArticle.title, 'English source');
    assert.equal(res.body.data.languageStates.siblingArticles.length, 1);
    assert.equal(res.body.data.languageStates.siblingArticles[0].id, '507f1f77bcf86cd799439202');
    assert.equal(res.body.data.languageStates.siblingArticles[0].lang, 'hi');
    assert.equal(res.body.data.perLang.en.present, true);
    assert.equal(res.body.data.perLang.en.presence, 'source');
    assert.equal(res.body.data.perLang.hi.present, true);
    assert.equal(res.body.data.perLang.hi.presence, 'translated');
    assert.equal(res.body.data.perLang.gu.present, false);
    assert.equal(res.body.data.perLang.gu.presence, 'missing');
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});

test('GET /api/admin/articles/:id includes translationGroupStatus with source and child language states', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const originals = { findById: News.findById, find: News.find };

  try {
    mongoose.connection.readyState = 1;

    const sourceDoc = {
      _id: '507f1f77bcf86cd799439211',
      title: 'English source',
      slug: 'english-source',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      translationKey: 'grp-presence-2',
      translationGroupId: 'grp-presence-2',
      toJSON() {
        return {
          _id: this._id,
          title: this.title,
          slug: this.slug,
          lang: this.lang,
          language: this.language,
          originalLang: this.originalLang,
          translationKey: this.translationKey,
          translationGroupId: this.translationGroupId,
        };
      },
    };

    const groupDocs = [
      {
        _id: '507f1f77bcf86cd799439211',
        lang: 'en',
        language: 'en',
        translationKey: 'grp-presence-2',
        translationGroupId: 'grp-presence-2',
      },
      {
        _id: '507f1f77bcf86cd799439212',
        lang: 'hi',
        language: 'hi',
        translationKey: 'grp-presence-2',
        translationGroupId: 'grp-presence-2',
        title: 'Hindi child',
        slug: 'hindi-child',
        status: 'published',
      },
    ];

    News.findById = () => Promise.resolve(sourceDoc);
    News.find = () => makeFindResult(groupDocs);

    const token = makeOpaqueAdminToken();
    const res = await request(app)
      .get('/api/admin/articles/507f1f77bcf86cd799439211')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.translationGroupStatus.baseLang, 'en');
    assert.equal(res.body.translationGroupStatus.perLang.en.presence, 'source');
    assert.equal(res.body.translationGroupStatus.perLang.hi.presence, 'translated');
    assert.equal(res.body.translationGroupStatus.perLang.gu.presence, 'missing');
    assert.equal(res.body.translationGroupStatus.sourceArticle.id, '507f1f77bcf86cd799439211');
    assert.equal(res.body.translationGroupStatus.siblingArticles.length, 1);
    assert.equal(res.body.translationGroupStatus.siblingArticles[0].slug, 'hindi-child');
    assert.equal(res.body.translationGroupStatus.siblingArticles[0].title, 'Hindi child');
  } finally {
    restore(originals);
    mongoose.connection.readyState = prevReadyState;
  }
});