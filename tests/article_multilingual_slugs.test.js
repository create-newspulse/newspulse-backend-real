const isolation = require('./helpers/adminPutIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const { slugifyLocalizedTitle } = require('../lib/slug');
const { localizeArticleForLang } = require('../services/mapArticleForLang');
const { generateArticleTranslations } = require('../services/articleTranslationGeneration.service');
const { translateAndSave } = require('../services/publishAsyncTranslation.service');
const { publishCanonicalArticle } = require('../services/articlePublishing.service');
const googleTranslation = require('../services/googleTranslationService');
const googleTranslate = require('../services/googleTranslate.service');

const LANGUAGES = ['en', 'hi', 'gu'];
const TITLES = { en: 'Heritage 2026 in Gujarat', hi: 'गुजरात की विरासत २०२६', gu: 'ગુજરાતનો વારસો ૨૦૨૬' };
const IDS = { en: '507f1f77bcf86cd79943c001', hi: '507f1f77bcf86cd79943c002', gu: '507f1f77bcf86cd79943c003' };
const PUBLICATION = new Date('2020-01-01T08:00:00.000Z');

function article(lang, overrides = {}) {
  return {
    _id: IDS[lang], lang, language: lang, originalLang: lang,
    title: TITLES[lang], description: `${lang} summary`, summary: `${lang} summary`, content: `<p>${lang} body</p>`,
    slug: slugifyLocalizedTitle(TITLES[lang], lang), slugs: { [lang]: slugifyLocalizedTitle(TITLES[lang], lang) },
    category: 'national', status: 'published', publishedAt: PUBLICATION, deletedAt: null,
    seo: { metaTitle: 'Editorial SEO title', metaDescription: 'Editorial description', canonicalUrl: 'https://example.test/editorial' },
    ...overrides,
  };
}

const snapshot = state => structuredClone({ News: state.rows.News, Article: state.rows.Article });
const get = (state, path) => state.request('get', path, undefined, null);

test.afterEach(() => isolation.assertNoSideEffects());

test('legacy foreign slugs resolve on every alias while the EN ID fallback is stable and read-only', async t => {
  const state = installEditorialFixture(t);
  const legacy = 'ગુજરાતી-પ્રકાશિત-સમાચાર';
  state.rows.News.push(article('en', { slug: legacy, slugs: { gu: legacy } }));
  const before = snapshot(state);
  for (const path of [
    `/api/public/news/${encodeURIComponent(legacy)}?lang=en`,
    `/api/public/news/slug/${encodeURIComponent(legacy)}?lang=en`,
    `/api/articles/slug/${encodeURIComponent(legacy)}?lang=en`,
    `/api/articles/by-slug/${encodeURIComponent(legacy)}?lang=en`,
  ]) {
    const response = await get(state, path);
    assert.equal(response.status, 200, path);
    assert.equal(response.body.canonicalSlug, IDS.en, path);
    assert.equal(response.body.localizedSlug, IDS.en, path);
    assert.equal(response.headers.location, undefined);
  }
  const byId = await get(state, `/api/public/news/${IDS.en}?lang=en`);
  assert.equal(byId.status, 200);
  assert.equal(byId.body.canonicalSlug, IDS.en);
  assert.equal(byId.body.slug, legacy);
  assert.equal(byId.body.canonicalDetailUrl, `/news/${IDS.en}`);
  assert.equal(byId.body.detailApiUrl, `/api/public/news/${IDS.en}?lang=en`);
  const follow = await get(state, byId.body.detailApiUrl);
  assert.equal(follow.status, 200);
  assert.equal(follow.body.canonicalDetailUrl, byId.body.canonicalDetailUrl);
  assert.equal(follow.body.publishedAt, PUBLICATION.toISOString());
  assert.deepEqual(snapshot(state), before);
});

test('cached locales and public-only copies use a resolvable ID instead of another locale legacy slug', async t => {
  for (const model of ['News', 'Article']) {
    await t.test(model, async t => {
      const state = installEditorialFixture(t);
      const doc = article('gu', {
        slug: 'legacy-gu-transliteration', slugs: {},
        translations: { en: { title: TITLES.en, summary: 'English summary', content: '<p>English body</p>' } },
        translationStatus: { en: 'ready' },
      });
      state.rows[model].push(doc);
      const before = snapshot(state);
      const response = await get(state, `/api/public/news/legacy-gu-transliteration?lang=en`);
      assert.equal(response.status, 200);
      assert.equal(response.body.title, TITLES.en);
      assert.equal(response.body.canonicalSlug, doc._id);
      assert.equal(response.body.canonicalDetailUrl, `/news/${doc._id}`);
      const byId = await get(state, response.body.detailApiUrl);
      assert.equal(byId.status, 200);
      assert.equal(byId.body.canonicalSlug, doc._id);
      assert.equal(byId.body.title, TITLES.en);
      assert.equal(localizeArticleForLang(doc, 'en').canonicalSlug, doc._id);
      assert.deepEqual(snapshot(state), before);
    });
  }
});

test('missing native slugs use the supported EN, HI and GU ID paths, including an ID-shaped legacy alias', async t => {
  const state = installEditorialFixture(t);
  for (const lang of LANGUAGES) {
    const legacy = lang === 'gu' ? 'पुराना-समाचार' : 'જૂના-સમાચાર';
    state.rows.News.push(article(lang, { slug: legacy, slugs: {} }));
    const response = await get(state, `/api/public/news/${IDS[lang]}?lang=${lang}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.canonicalSlug, IDS[lang]);
    assert.equal(response.body.canonicalDetailUrl, `${lang === 'en' ? '' : `/${lang}`}/news/${IDS[lang]}`);
    assert.equal((await get(state, response.body.detailApiUrl)).body.canonicalSlug, IDS[lang]);
  }
  state.rows.News[0].slug = '507f1f77bcf86cd79943c099';
  const alias = await get(state, `/api/public/news/slug/${state.rows.News[0].slug}?lang=en`);
  assert.equal(alias.status, 200);
  assert.equal(alias.body.canonicalSlug, IDS.en);
});

test('decoded and encoded stored aliases select the same published edition and canonical URL', async t => {
  const state = installEditorialFixture(t);
  const slugs = Object.fromEntries(LANGUAGES.map(lang => [lang, slugifyLocalizedTitle(TITLES[lang], lang)]));
  for (const lang of LANGUAGES) {
    state.rows.News.push(article(lang, {
      slugs: { ...slugs, gu: encodeURIComponent(slugs.gu) },
      slug: lang === 'gu' ? encodeURIComponent(slugs.gu) : slugs[lang],
      sourceArticleId: IDS.gu, sourceLanguage: 'gu', translationGroupId: 'native-slug-group', translationKey: 'native-slug-group',
    }));
  }
  const before = snapshot(state);
  for (const lang of LANGUAGES) {
    for (const alias of [slugs.gu, encodeURIComponent(slugs.gu), slugs.en]) {
      const response = await get(state, `/api/public/news/${encodeURIComponent(alias)}?lang=${lang}`);
      assert.equal(response.status, 200);
      assert.equal(response.body._id, IDS[lang]);
      assert.equal(response.body.canonicalSlug, slugs[lang]);
      const follow = await get(state, response.body.detailApiUrl);
      assert.equal(follow.status, 200);
      assert.equal(follow.body._id, response.body._id);
      assert.equal(follow.body.canonicalDetailUrl, response.body.canonicalDetailUrl);
      assert.equal(follow.headers.location, undefined);
    }
  }
  assert.deepEqual(snapshot(state), before);
});

test('ambiguous aliases fail closed across stories and public copies, while hidden editions stay hidden', async t => {
  for (const otherModel of ['News', 'Article']) {
    await t.test(otherModel, async t => {
      const state = installEditorialFixture(t);
      state.rows.News.push(article('en', { slug: 'shared-alias', slugs: {} }));
      const conflicting = article('hi', { slug: 'different-slug', slugs: { en: 'shared-alias' } });
      state.rows[otherModel].push(conflicting);
      for (const path of ['/api/public/news/shared-alias?lang=en', '/api/public/news/slug/shared-alias?lang=en', '/api/articles/by-slug/shared-alias?lang=en']) {
        const response = await get(state, path);
        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'ARTICLE_SLUG_AMBIGUOUS');
        assert.equal(response.body.title, undefined);
        assert.equal(response.headers.location, undefined);
      }
      const byId = await get(state, `/api/public/news/${IDS.en}?lang=en`);
      assert.equal(byId.status, 200);
      assert.equal(byId.body.canonicalSlug, IDS.en);
      const followed = await get(state, byId.body.detailApiUrl);
      assert.equal(followed.status, 200);
      assert.equal(followed.body._id, IDS.en);
      assert.equal(followed.body.canonicalDetailUrl, byId.body.canonicalDetailUrl);
      conflicting.status = 'draft';
      assert.equal((await get(state, '/api/public/news/shared-alias?lang=en')).status, 200);
      assert.equal((await get(state, `/api/public/news/${conflicting._id}?lang=hi`)).status, 404);
    });
  }
});

test('an unambiguous legacy alias cannot emit a colliding localized canonical URL', async t => {
  const state = installEditorialFixture(t);
  state.rows.News.push(
    article('en', { slug: 'english-legacy', slugs: { en: 'shared-canonical' } }),
    article('hi', { slug: 'different-story', slugs: { en: 'shared-canonical' } }),
  );
  const before = snapshot(state);
  for (const prefix of ['/api/public/news', '/api/public/news/slug', '/api/articles/slug', '/api/articles/by-slug']) {
    const response = await get(state, `${prefix}/english-legacy?lang=en`);
    assert.equal(response.status, 200);
    assert.equal(response.body.canonicalSlug, IDS.en);
    assert.equal(response.headers.location, undefined);
  }
  assert.deepEqual(snapshot(state), before);
});

test('legacy casing and percent encoding cannot advertise an unregistered normalized canonical URL', async t => {
  const state = installEditorialFixture(t);
  for (const alias of ['Legacy-English-URL', 'legacy-%65nglish-url']) {
    state.rows.News = [article('en', { slug: alias, slugs: { en: alias } })];
    const before = snapshot(state);
    for (const prefix of ['/api/public/news', '/api/public/news/slug', '/api/articles/slug', '/api/articles/by-slug']) {
      const response = await get(state, `${prefix}/${encodeURIComponent(alias)}?lang=en`);
      assert.equal(response.status, 200);
      assert.equal(response.body.canonicalSlug, IDS.en);
      assert.equal(response.headers.location, undefined);
      if (response.body.detailApiUrl) {
        const followed = await get(state, response.body.detailApiUrl);
        assert.equal(followed.status, 200);
        assert.equal(followed.body.canonicalSlug, IDS.en);
      }
    }
    assert.deepEqual(snapshot(state), before);
  }
});

test('duplicate requested editions and conflicting group roots are not resolved by findOne order', async t => {
  const state = installEditorialFixture(t);
  const first = article('en', {
    slug: 'duplicate-alias', slugs: {}, sourceArticleId: IDS.en,
    translationGroupId: 'duplicate-group', translationKey: 'duplicate-group',
  });
  const second = { ...first, _id: IDS.hi };
  state.rows.News.push(first, second);
  assert.equal((await get(state, '/api/public/news/duplicate-alias?lang=en')).status, 409);
  Object.assign(second, { lang: 'hi', language: 'hi', originalLang: 'hi', sourceArticleId: IDS.hi });
  assert.equal((await get(state, '/api/public/news/duplicate-alias?lang=en')).status, 409);
});

test('new article creation generates native slugs and keeps collision suffixes', async t => {
  const state = installEditorialFixture(t);
  for (const lang of LANGUAGES) {
    const response = await state.request('post', '/api/articles', {
      title: TITLES[lang], summary: `${lang} summary`, content: `<p>${lang} body</p>`, category: 'national', language: lang,
    });
    assert.equal(response.status, 201);
    const doc = state.rows.News.find(doc => doc.language === lang);
    assert.equal(doc.slug, slugifyLocalizedTitle(TITLES[lang], lang));
    assert.equal(doc.slugs[lang], doc.slug);
  }
  const duplicate = await state.request('post', '/api/articles', {
    title: TITLES.en, summary: 'Another story', content: '<p>Different story</p>', category: 'national', language: 'en',
  });
  assert.equal(duplicate.status, 201);
  assert.equal(state.rows.News.at(-1).slug, `${slugifyLocalizedTitle(TITLES.en, 'en')}-2`);
});

test('new localized aliases cannot collide with an unrelated public-only article', async t => {
  const state = installEditorialFixture(t);
  state.rows.Article.push(article('hi', { slugs: { hi: 'reserved-localized-alias' }, slug: 'public-story' }));
  const before = snapshot(state);
  const response = await state.request('post', '/api/articles', {
    title: TITLES.en, summary: 'Summary', content: '<p>Body</p>', category: 'national', language: 'en',
    slugs: { hi: 'reserved-localized-alias' },
  });
  assert.equal(response.status, 409);
  assert.deepEqual(snapshot(state), before);
});

test('new translated siblings use translated titles, not inherited legacy locale slugs', async t => {
  const state = installEditorialFixture(t);
  const source = article('gu', {
    status: 'draft', publishedAt: null, translationKey: 'generation-slugs', translationGroupId: 'generation-slugs',
    slugs: { en: 'જૂનો-લેખ', hi: 'જૂનો-લેખ', gu: 'જૂનો-લેખ' }, slug: 'જૂનો-લેખ',
  });
  state.rows.News.push(source);
  const before = structuredClone(source);
  t.mock.method(googleTranslation, 'translateText', async (_value, _source, target) => ({ ok: true, text: TITLES[target] }));
  const response = await generateArticleTranslations(source, { targetLanguages: ['en', 'hi'] });
  assert.equal(response.ok, true);
  for (const lang of ['en', 'hi']) {
    const child = state.rows.News.find(doc => doc.language === lang);
    assert.equal(child.slug, slugifyLocalizedTitle(TITLES[lang], lang));
    assert.equal(child.slugs[lang], child.slug);
    assert.equal(child.sourceArticleId, source._id);
    assert.equal(child.translationGroupId, source.translationGroupId);
    assert.equal(child.status, 'draft');
  }
  for (const [field, value] of Object.entries(before)) assert.deepEqual(source[field], value, field);
});

test('publication creates cached siblings from their own titles without rewriting published URLs on repeat', async t => {
  const state = installEditorialFixture(t);
  const source = article('gu', {
    status: 'draft', publishedAt: null, translationKey: 'cached-slugs', translationGroupId: 'cached-slugs',
    slugs: { gu: 'જૂનું-સરનામું', en: 'જૂનું-સરનામું', hi: 'જૂનું-સરનામું' }, slug: 'જૂનું-સરનામું',
    translations: Object.fromEntries(['en', 'hi'].map(lang => [lang, {
      title: TITLES[lang], summary: `${lang} summary`, content: `<p>${lang} body</p>`, provider: 'manual',
    }])),
  });
  state.rows.News.push(source);
  await publishCanonicalArticle(state.newsDoc(source._id));
  for (const lang of ['en', 'hi']) {
    const child = state.rows.News.find(doc => doc.language === lang);
    assert.equal(child.slug, slugifyLocalizedTitle(TITLES[lang], lang));
    assert.equal(child.status, 'published');
    assert.equal(state.rows.Article.find(doc => doc.sourceNewsId === child._id).slug, child.slug);
  }
  const urls = state.rows.News.map(doc => ({ id: doc._id, slug: doc.slug, slugs: structuredClone(doc.slugs), publishedAt: doc.publishedAt }));
  await publishCanonicalArticle(state.newsDoc(source._id));
  assert.deepEqual(state.rows.News.map(doc => ({ id: doc._id, slug: doc.slug, slugs: doc.slugs, publishedAt: doc.publishedAt })), urls);
});

test('published Save Update and cover removal retain legacy URLs, IDs, dates and editorial SEO', async t => {
  const state = installEditorialFixture(t);
  const { ids } = seedGroup(state);
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    doc.seo = { metaTitle: 'Editorial title', metaDescription: 'Editorial text', canonicalUrl: 'https://example.test/custom' };
    doc.slugs = { gu: 'જૂનું-સરનામું' };
  }
  const before = snapshot(state);
  const response = await state.request('put', `/api/articles/${ids[0]}`, {
    title: 'Updated English title', content: '<p>Updated English body</p>', removeCoverImage: true,
  });
  assert.equal(response.status, 200);
  for (const model of ['News', 'Article']) {
    for (const previous of before[model]) {
      const current = state.rows[model].find(doc => doc._id === previous._id);
      for (const field of ['_id', 'slug', 'slugs', 'status', 'publishedAt', 'translationKey', 'translationGroupId', 'sourceArticleId', 'sourceNewsId', 'seo']) {
        assert.deepEqual(current[field], previous[field], `${model}.${field}`);
      }
    }
  }
  const edited = state.rows.News.find(doc => doc._id === ids[0]);
  assert.equal(edited.coverImage.removed, true);
  assert.equal(edited.coverImage.url, null);
});

test('republishing preserves distinct historical public URLs and dates and invalidates their real paths', async t => {
  const state = installEditorialFixture(t);
  const { ids } = seedGroup(state);
  for (const copy of state.rows.Article) {
    copy.slug = `historical-public-${copy.language}`;
    copy.slugs = { [copy.language]: copy.slug };
    copy.publishedAt = new Date('2019-01-01T08:00:00.000Z');
  }
  const before = snapshot(state);
  const published = await state.request('post', `/api/articles/${ids[0]}/publish`, {});
  assert.equal(published.status, 200, published.text);
  for (const model of ['News', 'Article']) {
    for (const previous of before[model]) {
      const current = state.rows[model].find(doc => doc._id === previous._id);
      for (const field of ['_id', 'slug', 'slugs', 'status', 'publishedAt', 'sourceArticleId', 'sourceNewsId']) {
        assert.deepEqual(current[field], previous[field], `${model}.${field}`);
      }
    }
  }
  assert.ok(state.invalidations.some(event => event.paths?.includes('/news/historical-public-en')));
  const response = await get(state, '/api/public/news/historical-public-en?lang=en');
  assert.equal(response.status, 200);
  assert.equal(response.body.canonicalSlug, 'historical-public-en');
});

test('background translation cannot replace or backfill published URL maps', async t => {
  const state = installEditorialFixture(t);
  process.env.GOOGLE_TRANSLATE_API_KEY = 'unit-test-only';
  t.after(() => { delete process.env.GOOGLE_TRANSLATE_API_KEY; });
  const source = article('en', { slugs: { en: 'old-english-url', hi: 'पुराना-सरनामा' }, slug: 'old-english-url' });
  state.rows.News.push(source);
  state.rows.Article.push(article('en', {
    _id: IDS.en.replace(/^5/, '6'), sourceNewsId: source._id, sourceArticleId: source._id,
    slug: 'public-original-url', slugs: { en: 'public-original-url' }, publishedAt: new Date('2019-01-01T08:00:00.000Z'),
  }));
  const before = snapshot(state);
  t.mock.method(googleTranslate, 'translateMany', async (values, target) => ({
    ok: true, items: values.map(() => TITLES[target]),
  }));
  await translateAndSave(source._id, { logger: { info() {}, warn() {}, error() {} } });
  for (const model of ['News', 'Article']) {
    const current = state.rows[model][0];
    for (const field of ['_id', 'slug', 'slugs', 'publishedAt', 'status', 'seo']) {
      assert.deepEqual(current[field], before[model][0][field], `${model}.${field}`);
    }
  }
  assert.ok(state.invalidations.some(event => event.paths?.includes('/news/public-original-url')));
});

test('model validation does not normalize untouched encoded published slug fields', async () => {
  for (const Model of [News, PublicArticle]) {
    const encoded = encodeURIComponent('ગુજરાતી-સરનામું');
    const doc = Model.hydrate(article('gu', { sourceLanguage: 'gu', slug: encoded, slugs: { gu: encoded } }));
    doc.title = 'Updated headline';
    await doc.validate();
    assert.equal(doc.slug, encoded);
    assert.equal(doc.slugs.gu, encoded);
  }
});
