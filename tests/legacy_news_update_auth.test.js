require('./helpers/publicNewsIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../server');
const News = require('../models/News');
const User = require('../models/User');
const { slugifyUnicode } = require('../lib/slug');
const { accountAuthFixture } = require('./helpers/accountAuthFixture');
const { installEditorialFixture } = require('./helpers/editorialLifecycleFixture');

const ARTICLE_ID = '507f1f77bcf86cd799439011';
const MISSING_ID = '507f1f77bcf86cd799439099';
const BASES = ['/api/news', '/api/api/news'];
const METHODS = ['put', 'patch'];
const TITLES = {
  en: 'Synthetic English title',
  hi: '\u0939\u093f\u0902\u0926\u0940 \u0936\u0940\u0930\u094d\u0937\u0915',
  gu: '\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4\u0ac0 \u0ab6\u0ac0\u0ab0\u0acd\u0ab7\u0a95',
};

function installLegacyFixture(context, { account = {}, language = 'en', status = 'draft' } = {}) {
  const auth = accountAuthFixture();
  auth.install(context);
  const findUser = User.findById;
  const accountLookup = context.mock.method(User, 'findById', id => {
    const query = findUser(id);
    return {
      ...query,
      lean: async () => {
        const user = await query.lean();
        return user ? { ...user, specialRightsOverride: ['news_edit'], ...account } : null;
      },
    };
  });
  context.mock.method(User, 'findByIdAndUpdate', () => assert.fail('Unexpected account mutation'));

  const doc = new News({
    _id: ARTICLE_ID,
    title: 'Original title',
    description: 'Original summary',
    content: '<p>Original content</p>',
    category: 'national',
    language, lang: language, originalLang: language, sourceLanguage: language,
    status, workflowStage: status === 'published' ? 'PUBLISHED' : 'DRAFT',
    publishedAt: status === 'published' ? new Date('2026-01-02T00:00:00.000Z') : null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    slug: 'legacy-auth-story',
    slugs: Object.fromEntries(Object.entries(TITLES).map(([lang, title]) => [lang, slugifyUnicode(title)])),
    translationGroupId: 'legacy-auth-group',
    translationKey: 'legacy-auth-group',
    sourceArticleId: ARTICLE_ID,
    translations: Object.fromEntries(Object.entries(TITLES).map(([lang, title]) => [
      lang, { title, summary: `Summary ${lang}`, content: `<p>${title}</p>` },
    ])),
    translationStatus: { en: 'ready', hi: 'ready', gu: 'ready' },
    coverImage: { url: 'https://example.invalid/original.jpg', publicId: 'legacy-cover' },
    views: 17,
  });
  const before = doc.toObject();
  const save = context.mock.method(doc, 'save', async () => doc);
  const lookup = context.mock.method(News, 'findById', async id => String(id) === ARTICLE_ID ? doc : null);
  return { auth, doc, before, save, lookup, accountLookup };
}

function assertNoArticleAccess(state) {
  assert.equal(state.lookup.mock.callCount(), 0);
  assert.equal(state.save.mock.callCount(), 0);
  assert.deepEqual(state.doc.toObject(), state.before);
}

const deniedCases = [
  { name: 'anonymous', token: () => null },
  { name: 'malformed token', token: () => 'not-a-signed-access-token' },
  { name: 'legacy opaque token', token: () => 'np.unsigned-legacy-token' },
  { name: 'incorrect signature', token: auth => auth.token('editor', {}, crypto.randomBytes(32).toString('hex')) },
  { name: 'expired token', token: auth => auth.token('editor', { iat: Math.floor(Date.now() / 1000) - 3600 }) },
  { name: 'refresh token', token: auth => auth.token('editor', { type: 'refresh' }) },
  { name: 'missing access-token type', token: auth => auth.token('editor', { type: undefined }) },
  { name: 'missing persisted account', token: auth => auth.token('editor', { sub: MISSING_ID }) },
  { name: 'unsupported role', token: auth => auth.token('visitor'), status: 403, code: 'FORBIDDEN' },
  { name: 'revoked token', account: { tokenVersion: 1 } },
  { name: 'disabled login', account: { loginAllowed: false }, status: 403, code: 'LOGIN_DISABLED' },
  { name: 'suspended account', account: { accountStatus: 'suspended' }, status: 403, code: 'ACCOUNT_SUSPENDED' },
  { name: 'locked account', account: { accountStatus: 'locked' }, status: 403, code: 'ACCOUNT_LOCKED' },
  { name: 'archived account', account: { accountStatus: 'archived' }, status: 403, code: 'ACCOUNT_ARCHIVED' },
  { name: 'deleted account', account: { isDeleted: true }, status: 403, code: 'ACCOUNT_DELETED' },
  { name: 'expired account', account: { accountStatus: 'expired', loginAllowed: false }, status: 403, code: 'ACCOUNT_EXPIRED' },
  { name: 'unavailable authentication store', unavailable: true, status: 503, code: 'AUTH_UNAVAILABLE' },
];

for (const base of BASES) {
  for (const method of METHODS) {
    const label = `${method.toUpperCase()} ${base}/:id`;
    const path = `${base}/${ARTICLE_ID}`;

    for (const scenario of deniedCases) {
      test(`${label} denies ${scenario.name} requests before article access`, async context => {
        const state = installLegacyFixture(context, { account: scenario.account });
        const token = scenario.token ? scenario.token(state.auth) : state.auth.token('editor');
        if (scenario.unavailable) mongoose.connection.readyState = 0;
        let call = request(app)[method](path);
        if (token) call = call.auth(token, { type: 'bearer' });
        const response = await call.send({
          title: 'Must not be saved', status: 'published', role: 'founder', userId: ARTICLE_ID,
          translations: { gu: { title: 'Must not replace a translation' } },
        });
        assert.equal(response.status, scenario.status || 401, `Article saves before rejection: ${state.save.mock.callCount()}`);
        assert.equal(response.body.code, scenario.code || 'UNAUTHORIZED');
        assert.equal(response.body.ok, false);
        assertNoArticleAccess(state);
      });
    }

    for (const role of ['founder', 'admin', 'editor']) {
      for (const language of ['en', 'hi', 'gu']) {
        test(`${label} preserves authenticated ${role} ${language} save behavior and response`, async context => {
          const state = installLegacyFixture(context, { language, status: role === 'founder' ? 'published' : 'draft' });
          const response = await request(app)[method](`${path}/?legacy=1`)
            .auth(state.auth.token(role), { type: 'bearer' })
            .send({
              title: TITLES[language], description: 'Updated summary', content: `<p>${TITLES[language]}</p>`,
              [language === 'hi' ? 'language' : 'lang']: language,
            });
          assert.equal(response.status, 200);
          assert.deepEqual(response.body, { message: 'News updated successfully' });
          assert.equal(state.save.mock.callCount(), 1);
          const after = state.doc.toObject();
          assert.equal(after.title, TITLES[language]);
          assert.equal(after.description, 'Updated summary');
          assert.equal(after.content, `<p>${TITLES[language]}</p>`);
          assert.equal(after.lang, language);
          assert.equal(after.language, language);
          for (const field of [
            '_id', 'slug', 'slugs', 'status', 'workflowStage', 'workflowHistory', 'publishedAt', 'createdAt',
            'translationGroupId', 'translationKey', 'sourceArticleId', 'sourceLanguage', 'originalLang',
            'translations', 'translationStatus', 'coverImage', 'views',
          ]) assert.deepEqual(after[field], state.before[field], field);
        });
      }
    }

    for (const cookie of ['np_admin_token', 'np_token', 'token']) {
      test(`${label} accepts the existing signed ${cookie} cookie with a trusted Origin`, async context => {
        const state = installLegacyFixture(context);
        const response = await request(app)[method](path)
          .set('Cookie', `${cookie}=${state.auth.token('founder')}`)
          .set('Origin', 'http://localhost:5173')
          .send({ description: 'Cookie-authenticated save' });
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { message: 'News updated successfully' });
        assert.equal(state.save.mock.callCount(), 1);
      });
    }

    test(`${label} rejects invalid cookies and does not fall back from an invalid bearer token`, async context => {
      const state = installLegacyFixture(context);
      const invalidCookie = await request(app)[method](path)
        .set('Cookie', 'np_admin_token=not-a-signed-token')
        .set('Origin', 'http://localhost:5173').send({ title: 'Must not be saved' });
      assert.equal(invalidCookie.status, 401);
      const invalidBearer = await request(app)[method](path)
        .auth('not-a-signed-token', { type: 'bearer' })
        .set('Cookie', `np_admin_token=${state.auth.token('founder')}`)
        .set('Origin', 'http://localhost:5173').send({ title: 'Must not be saved' });
      assert.equal(invalidBearer.status, 401);
      assertNoArticleAccess(state);
    });

    test(`${label} preserves the shared cookie Origin requirement`, async context => {
      const state = installLegacyFixture(context);
      const response = await request(app)[method](path)
        .set('Cookie', `np_admin_token=${state.auth.token('founder')}`)
        .send({ title: 'Must not be saved' });
      assert.equal(response.status, 403);
      assert.equal(response.body.code, 'CSRF_ORIGIN_REQUIRED');
      assertNoArticleAccess(state);
    });

    test(`${label} preserves authenticated not-found and byline-validation errors`, async context => {
      const state = installLegacyFixture(context);
      const token = state.auth.token('founder');
      const invalid = await request(app)[method](path).auth(token, { type: 'bearer' })
        .send({ authorByline: { enabled: true, snapshot: { name: 'Synthetic Author' } } });
      assert.equal(invalid.status, 400);
      assert.deepEqual(invalid.body, { error: 'Author bylines must be saved through the authenticated articles API' });
      assertNoArticleAccess(state);
      const missing = await request(app)[method](`${base}/${MISSING_ID}`).auth(token, { type: 'bearer' })
        .send({ title: 'Missing story' });
      assert.equal(missing.status, 404);
      assert.deepEqual(missing.body, { error: 'Not found' });
      assert.equal(state.save.mock.callCount(), 0);
    });

    test(`${label} continues reporting storage failures instead of success`, async context => {
      const state = installLegacyFixture(context);
      context.mock.method(state.doc, 'save', async () => { throw new Error('Synthetic storage failure'); });
      const response = await request(app)[method](path).auth(state.auth.token('founder'), { type: 'bearer' })
        .send({ title: 'Attempted update' });
      assert.equal(response.status, 500);
      assert.deepEqual(response.body, { error: 'Synthetic storage failure' });
    });
  }

  for (const suffix of ['', '/news']) {
    test(`legacy POST ${base}${suffix} creation remains separate from update authentication`, async context => {
      const state = installLegacyFixture(context);
      const created = [];
      context.mock.method(News.prototype, 'save', async function () {
        created.push(this.toObject());
        return this;
      });
      const response = await request(app).post(`${base}${suffix}`)
        .auth(state.auth.token('editor'), { type: 'bearer' })
        .send({ title: 'New draft', description: 'Draft summary', content: '<p>Draft content</p>', language: 'gu', status: 'draft' });
      assert.equal(response.status, 201);
      assert.deepEqual(response.body, { message: 'News created successfully' });
      assert.equal(created.length, 1);
      assert.equal(created[0].status, 'draft');
      assert.equal(created[0].lang, 'gu');
      assert.equal(state.accountLookup.mock.callCount(), 0);
    });

    test(`legacy GET ${base}${suffix} remains public`, async context => {
      const state = installLegacyFixture(context, { status: 'published' });
      context.mock.method(News, 'find', () => ({ sort: async () => [state.doc] }));
      const response = await request(app).get(`${base}${suffix}`);
      assert.equal(response.status, 200);
      assert.equal(response.body.length, 1);
      assert.equal(response.body[0].title, state.doc.title);
      assert.equal(state.accountLookup.mock.callCount(), 0);
      assertNoArticleAccess(state);
    });
  }
}

for (const language of ['en', 'hi', 'gu']) {
  test(`canonical Add News ${language} creation and subsequent draft saves remain unchanged`, async context => {
    const state = installEditorialFixture(context);
    const created = await state.request('post', '/api/articles', {
      title: TITLES[language], description: 'Synthetic draft summary', content: `<p>${TITLES[language]}</p>`,
      category: 'national', language, status: 'draft',
    }, 'reporter');
    assert.equal(created.status, 201);
    const id = created.body.article._id;
    for (const method of METHODS) {
      const saved = await state.request(method, `/api/articles/${id}`, { title: `${TITLES[language]} updated` }, 'reporter');
      assert.equal(saved.status, 200);
      assert.equal(saved.body.article.status, 'draft');
      assert.equal(saved.body.article.language, language);
    }
  });
}
