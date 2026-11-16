require('./helpers/publicNewsIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Article = require('../models/Article');
const News = require('../models/News');
const BroadcastItem = require('../models/BroadcastItem');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const { installEditorialFixture } = require('./helpers/editorialLifecycleFixture');
const { hasVisibleNewsSource } = require('../services/publicArticleVisibility.service');

const LANGUAGES = ['gu', 'hi', 'en'];
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const id = value => value.toString(16).padStart(24, '0');
const CASES = [
  { name: 'visible parent', mode: 'visible', visible: true },
  { name: 'deleted parent', mode: 'deleted', visible: false },
  { name: 'private parent', mode: 'hidden', visible: false },
  { name: 'missing explicit parent', mode: 'missing', visible: false },
  { name: 'canonical-only shared copy', mode: 'canonical-only', visible: true },
  { name: 'source-less historical copy', mode: 'public-only', visible: true },
  { name: 'deleted canonical-only parent', mode: 'deleted', visible: false, canonicalOnly: true },
  { name: 'private canonical-only parent', mode: 'hidden', visible: false, canonicalOnly: true },
  { name: 'missing canonical-only parent', mode: 'missing', visible: false, canonicalOnly: true },
];
const SURFACES = [
  {
    name: 'stories', category: 'regional',
    path: (lang, page = 1, limit = 20) => `/api/public/stories?lang=${lang}&page=${page}&limit=${limit}`,
    slugs: body => body.data.map(item => item.slug),
  },
  {
    name: 'grouped stories', category: 'regional',
    path: (lang, page = 1, limit = 20) => `/api/public/stories?category=regional&lang=${lang}&page=${page}&limit=${limit}`,
    slugs: body => body.data.map(item => item.slug),
  },
  {
    name: 'regional query', category: 'regional',
    path: (lang, page = 1, limit = 20) => `/api/public/regional?state=gujarat&lang=${lang}&page=${page}&limit=${limit}`,
    slugs: body => body.data.items.map(item => item.slug),
    counted: true,
  },
  {
    name: 'regional state alias', category: 'regional',
    path: (lang, page = 1, limit = 20) => `/api/public/regional/gujarat?lang=${lang}&page=${page}&limit=${limit}`,
    slugs: body => body.data.items.map(item => item.slug),
    counted: true,
  },
  {
    name: 'Spotlight', category: 'regional',
    path: lang => `/api/public/homepage/center-slot?lang=${lang}`,
    slugs: body => body.items.map(item => item.article.slug),
  },
  {
    name: 'Article ticker fallback', category: 'national',
    path: (lang, _page = 1, limit = 20) => `/api/ticker/national-live?lang=${lang}&limit=${limit}`,
    slugs: body => body.map(item => {
      assert.equal(item.kind, 'story');
      return item.href.replace(/^\/news\//, '');
    }),
  },
];

function install(context) {
  const state = installEditorialFixture(context);
  const previousDb = mongoose.connection.db;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.db = previousDb; });
  context.mock.method(PublicSiteSettings, 'getOrCreate', async () => ({
    published: { languageTheme: { languages: LANGUAGES } },
  }));
  context.mock.method(BroadcastItem, 'find', () => ({
    sort() { return this; },
    limit() { return this; },
    lean: async () => [],
  }));
  state.get = path => state.request('get', path, undefined, null);
  return state;
}

function seed(state, mode, language, { index = 1, category = 'regional', hoursAgo = 1 } = {}) {
  const slug = `visibility-story-${index}`;
  const group = `visibility-group-${index}`;
  const publishedAt = new Date(NOW - hoursAgo * HOUR);
  const translations = Object.fromEntries(LANGUAGES.map(lang => [lang, {
    title: `${lang} headline ${index}`, summary: `${lang} summary ${index}`,
    content: `<p>${lang} body ${index}</p>`, provider: 'manual', generatedAt: publishedAt,
  }]));
  const source = {
    _id: id(index), slug, slugs: Object.fromEntries(LANGUAGES.map(lang => [lang, slug])),
    title: translations[language].title, description: translations[language].summary,
    content: translations[language].content,
    language, lang: language, originalLang: language, sourceLanguage: language,
    sourceArticleId: id(index), translationGroupId: group, translationKey: group,
    status: 'published', deletedAt: null, visibility: 'public', isPrivate: false,
    locked: false, embargoUntil: null, publishAt: null, scheduledAt: null,
    publishedAt, createdAt: new Date(publishedAt.getTime() - HOUR), updatedAt: publishedAt,
    category, geo: { state: 'gujarat' }, state: 'Gujarat', tags: ['state:gujarat'],
    coverImage: { url: '/uploads/visibility-test.jpg', publicId: 'visibility-test', alt: 'Test cover' },
    translations, translationStatus: Object.fromEntries(LANGUAGES.map(lang => [lang, 'ready'])),
    spotlightPriority: 'normal', spotlightExpiresAt: null,
  };
  const copy = {
    ...structuredClone(source), _id: id(1000 + index),
    summary: source.description, sourceNewsId: source._id,
  };
  state.rows.News.push(source);
  state.rows.Article.push(copy);

  if (mode === 'deleted') Object.assign(source, {
    status: 'deleted', deletedAt: new Date(NOW - HOUR / 2), deletedFromStatus: 'published',
  });
  else if (mode === 'hidden') source.visibility = 'private';
  else if (mode === 'missing' || mode === 'public-only') {
    state.rows.News = state.rows.News.filter(doc => doc !== source);
    if (mode === 'public-only') Object.assign(copy, {
      sourceNewsId: null, sourceArticleId: null, sourceLanguage: null,
      translationKey: null, translationGroupId: null,
    });
  } else if (mode === 'canonical-only') copy.sourceNewsId = null;
  else if (mode === 'deleted-representative') {
    const canonicalLanguage = LANGUAGES.find(lang => lang !== language);
    Object.assign(source, {
      language: canonicalLanguage, lang: canonicalLanguage, originalLang: canonicalLanguage,
      sourceLanguage: canonicalLanguage, title: translations[canonicalLanguage].title,
      description: translations[canonicalLanguage].summary, content: translations[canonicalLanguage].content,
    });
    const representative = {
      ...structuredClone(copy), _id: id(2000 + index), sourceLanguage: canonicalLanguage,
      status: 'deleted', deletedAt: new Date(NOW - HOUR / 2), deletedFromStatus: 'published',
    };
    delete representative.sourceNewsId;
    state.rows.News.push(representative);
    copy.sourceNewsId = representative._id;
    copy.sourceLanguage = canonicalLanguage;
  } else if (mode === 'contradictory') {
    const foreign = {
      ...structuredClone(source), _id: id(3000 + index), sourceArticleId: id(3000 + index),
      translationKey: `foreign-${index}`, translationGroupId: `foreign-${index}`,
      slug: `foreign-story-${index}`,
      slugs: Object.fromEntries(LANGUAGES.map(lang => [lang, `foreign-story-${index}`])),
    };
    state.rows.News.push(foreign);
    copy.sourceArticleId = foreign._id;
    copy.translationGroupId = foreign.translationGroupId;
  } else assert.equal(mode, 'visible', 'Unknown persisted-state fixture');

  return { source, copy };
}

function preserveState(context, state) {
  const before = structuredClone({ News: state.rows.News, Article: state.rows.Article });
  context.after(() => {
    assert.deepEqual({ News: state.rows.News, Article: state.rows.Article }, before,
      'Public reads must not repair/relink fixtures or change identities, media, slugs, translations or chronology');
    assert.equal(state.invalidations.length, 0);
    assert.equal(state.rows.TranslationJob.length, 0);
  });
}

async function assertDetails(state, copy, language, visible) {
  for (const path of [
    `/api/public/stories/${copy.slug}?lang=${language}`,
    `/api/public/news/${copy._id}?lang=${language}`,
    `/api/articles/${copy._id}?lang=${language}`,
  ]) {
    const response = await state.get(path);
    assert.equal(response.status, visible ? 200 : 404, `${path}: ${response.text}`);
  }
}

for (const language of LANGUAGES) for (const scenario of CASES) for (const surface of SURFACES) {
  test(`${language} ${surface.name}: ${scenario.name} agrees with public details`, async context => {
    const state = install(context);
    const { copy } = seed(state, scenario.mode, language, { category: surface.category });
    if (scenario.canonicalOnly) copy.sourceNewsId = null;
    preserveState(context, state);
    await assertDetails(state, copy, language, scenario.visible);
    const response = await state.get(surface.path(language));
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(surface.slugs(response.body), scenario.visible ? [copy.slug] : []);
    if (surface.counted) {
      assert.equal(response.body.data.total, scenario.visible ? 1 : 0);
      assert.equal(response.body.data.page, 1);
      assert.equal(response.body.data.limit, 20);
    }
  });
}

const HIDDEN_PARENT_PATCHES = [
  ['draft', { status: 'draft' }],
  ['archived', { status: 'archived' }],
  ['tombstone', { deletedAt: new Date(NOW - HOUR / 2) }],
  ['private flag', { isPrivate: true }],
  ['locked', { locked: true }],
  ['workflow lock', { workflow: { locked: true } }],
  ['embargo', { embargoUntil: new Date(NOW + HOUR) }],
  ['workflow embargo', { workflow: { embargoUntil: new Date(NOW + HOUR) } }],
  ['future publication', { publishedAt: new Date(NOW + HOUR) }],
  ['future publishAt', { publishAt: new Date(NOW + HOUR) }],
  ['future schedule', { scheduledAt: new Date(NOW + HOUR) }],
];
for (const language of LANGUAGES) for (const [name, patch] of HIDDEN_PARENT_PATCHES) {
  test(`${language} stories reject a ${name} CMS parent despite a published public copy`, async context => {
    const state = install(context);
    const { source, copy } = seed(state, 'visible', language);
    Object.assign(source, structuredClone(patch));
    preserveState(context, state);
    assert.equal(await hasVisibleNewsSource(copy), false);
    const detail = await state.get(`/api/public/stories/${copy.slug}?lang=${language}`);
    assert.equal(detail.status, 404, detail.text);
    const response = await state.get(SURFACES[0].path(language));
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body.data, []);
  });
}

for (const language of LANGUAGES) for (const surface of SURFACES.slice(0, 4)) {
  test(`${language} ${surface.name} excludes hidden groups before pagination and counts`, async context => {
    const state = install(context);
    const { copy: hidden } = seed(state, 'deleted', language, { hoursAgo: 0.1 });
    state.rows.Article.push({
      ...structuredClone(hidden), _id: id(1999), slug: 'hidden-group-duplicate',
      slugs: Object.fromEntries(LANGUAGES.map(lang => [lang, 'hidden-group-duplicate'])),
    });
    const { copy: first } = seed(state, 'canonical-only', language, { index: 10, hoursAgo: 2 });
    const { copy: second } = seed(state, 'public-only', language, { index: 11, hoursAgo: 3 });
    preserveState(context, state);
    for (const [page, expected] of [[1, first], [2, second]]) {
      const response = await state.get(surface.path(language, page, 1));
      assert.equal(response.status, 200, response.text);
      assert.deepEqual(surface.slugs(response.body), [expected.slug], `page ${page}`);
      if (surface.counted) {
        assert.equal(response.body.data.total, 2);
        assert.equal(response.body.data.page, page);
        assert.equal(response.body.data.limit, 1);
      }
    }
    const end = await state.get(surface.path(language, 3, 1));
    assert.equal(end.status, 200, end.text);
    assert.deepEqual(surface.slugs(end.body), []);
  });
}

for (const language of LANGUAGES) {
  test(`${language} Spotlight excludes hidden owners before priority selection and freshness expansion`, async context => {
    const state = install(context);
    for (let index = 1; index <= 8; index += 1) {
      const { copy } = seed(state, 'deleted', language, { index, hoursAgo: 1 });
      copy.spotlightPriority = 'top';
    }
    const { copy: visible } = seed(state, 'canonical-only', language, { index: 20, hoursAgo: 36 });
    preserveState(context, state);
    const surface = SURFACES.find(item => item.name === 'Spotlight');
    const response = await state.get(surface.path(language));
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.selectedSource, 'spotlight');
    assert.deepEqual(surface.slugs(response.body), [visible.slug]);
  });

  test(`${language} ticker excludes hidden owners before its bounded candidate limit`, async context => {
    const state = install(context);
    for (let index = 1; index <= 6; index += 1) {
      seed(state, 'deleted', language, { index, category: 'national', hoursAgo: 1 });
    }
    const { copy: visible } = seed(state, 'public-only', language, { index: 20, category: 'national', hoursAgo: 2 });
    preserveState(context, state);
    const surface = SURFACES.find(item => item.name === 'Article ticker fallback');
    const response = await state.get(surface.path(language, 1, 1));
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(surface.slugs(response.body), [visible.slug]);
  });
}

for (const language of LANGUAGES) for (const surface of SURFACES) {
  test(`${language} ${surface.name} must surface CMS eligibility lookup failures`, async context => {
    const state = install(context);
    seed(state, 'visible', language, { category: surface.category });
    for (const method of ['find', 'findOne', 'findById', 'aggregate']) {
      state.failures[`News.${method}`] = { name: 'MongoNetworkError' };
    }
    preserveState(context, state);
    const response = await state.get(surface.path(language));
    assert.ok([500, 503].includes(response.status),
      `CMS lookup failure must not return ${response.status}: ${response.text}`);
  });
}

for (const mode of ['canonical-only', 'public-only']) for (const language of LANGUAGES) {
  test(`${language} cached ${mode} content remains available without a CMS edition per language`, async context => {
    const state = install(context);
    const { copy } = seed(state, mode, 'en');
    preserveState(context, state);
    await assertDetails(state, copy, language, true);
    for (const surface of [SURFACES[1], SURFACES[2], SURFACES[3]]) {
      const response = await state.get(surface.path(language));
      assert.equal(response.status, 200, response.text);
      assert.deepEqual(surface.slugs(response.body), [copy.slug]);
      const item = surface.counted ? response.body.data.items[0] : response.body.data[0];
      assert.equal(item.title, copy.translations[language].title);
    }
    assert.equal(state.rows.News.some(doc => doc.language === language), mode === 'canonical-only' && language === 'en');
  });

  test(`${language} cached ${mode} ticker content does not require a separate CMS language edition`, async context => {
    const state = install(context);
    const { copy } = seed(state, mode, 'en', { category: 'national' });
    preserveState(context, state);
    const surface = SURFACES.find(item => item.name === 'Article ticker fallback');
    const response = await state.get(surface.path(language));
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(surface.slugs(response.body), [copy.slug]);
    assert.equal(response.body[0].text, copy.translations[language].title);
    await assertDetails(state, copy, language, true);
  });
}

test('Gujarati regional/base fallback remains distinct from strict Hindi and detail availability', async context => {
  const state = install(context);
  const { copy } = seed(state, 'visible', 'en');
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    for (const language of ['gu', 'hi']) {
      delete doc.translations[language];
      doc.translationStatus[language] = 'pending';
    }
  }
  preserveState(context, state);
  const gu = await state.get(SURFACES[2].path('gu'));
  assert.equal(gu.status, 200, gu.text);
  assert.equal(gu.body.data.total, 1);
  assert.equal(gu.body.data.items[0].title, copy.title);
  const hi = await state.get(SURFACES[2].path('hi'));
  assert.equal(hi.status, 200, hi.text);
  assert.equal(hi.body.data.total, 0);
  assert.deepEqual(hi.body.data.items, []);
  const stories = await state.get(SURFACES[0].path('gu'));
  assert.equal(stories.status, 200, stories.text);
  assert.deepEqual(stories.body.data, []);
  const detail = await state.get(`/api/public/stories/${copy.slug}?lang=gu`);
  assert.equal(detail.status, 404, detail.text);
  assert.equal(detail.body.code, 'LOCALE_NOT_AVAILABLE');
});

for (const language of LANGUAGES) for (const surface of SURFACES) {
  test(`${language} ${surface.name} excludes a deleted shared representative without choosing another sibling`, async context => {
    const state = install(context);
    const { source, copy } = seed(state, 'deleted-representative', language, { category: surface.category });
    const representative = state.rows.News.find(doc => doc._id === copy.sourceNewsId);
    assert.equal(source.status, 'published');
    assert.equal(representative.status, 'deleted');
    assert.equal(representative.sourceArticleId, source._id);
    assert.equal(copy.sourceArticleId, source._id);
    assert.equal(copy.slug, source.slug);
    assert.equal(copy.slug, representative.slug);
    assert.equal(copy.translationKey, source.translationKey);
    assert.equal(representative.translationGroupId, source.translationGroupId);
    preserveState(context, state);
    assert.equal(await hasVisibleNewsSource(copy), false);
    await assertDetails(state, copy, language, false);
    const response = await state.get(surface.path(language));
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(surface.slugs(response.body), []);
    if (surface.counted) assert.equal(response.body.data.total, 0);
  });

  test(`${language} ${surface.name} excludes contradictory ownership from listings and public-copy details`, async context => {
    const state = install(context);
    const { source, copy } = seed(state, 'contradictory', language, { category: surface.category });
    assert.notEqual(copy.sourceArticleId, source.sourceArticleId);
    assert.notEqual(copy.translationGroupId, copy.translationKey);
    preserveState(context, state);
    assert.equal(await hasVisibleNewsSource(copy), false);
    await assertDetails(state, copy, language, false);
    const response = await state.get(surface.path(language));
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(surface.slugs(response.body), []);
    if (surface.counted) assert.equal(response.body.data.total, 0);
  });
}

const COMPATIBILITY = [
  ['shared live representative', (state, source, copy) => {
    const owner = state.rows.News.find(doc => doc._id === copy.sourceNewsId);
    owner.status = 'published';
    owner.deletedAt = null;
  }],
  ['published edition with a draft canonical source', (state, source, copy) => {
    const owner = state.rows.News.find(doc => doc._id === copy.sourceNewsId);
    owner.status = 'published';
    owner.deletedAt = null;
    source.status = 'draft';
  }],
  ['missing optional canonical links and group keys', (state, source, copy) => {
    const owner = state.rows.News.find(doc => doc._id === copy.sourceNewsId);
    owner.status = 'published';
    owner.deletedAt = null;
    for (const doc of [source, owner, copy]) {
      delete doc.sourceArticleId;
      delete doc.translationGroupId;
      delete doc.translationKey;
    }
  }],
  ['legacy nested CMS source link', (state, source, copy) => {
    const owner = state.rows.News.find(doc => doc._id === copy.sourceNewsId);
    owner.status = 'published';
    owner.deletedAt = null;
    owner.translationMeta = { sourceArticleId: source._id };
    delete owner.sourceArticleId;
    delete source.sourceArticleId;
    delete source.translationKey;
    delete copy.translationGroupId;
  }],
];
for (const language of LANGUAGES) for (const surface of SURFACES) for (const [label, prepare] of COMPATIBILITY) {
  test(`${language} ${surface.name} preserves ${label}`, async context => {
    const state = install(context);
    const { source, copy } = seed(state, 'deleted-representative', language, { category: surface.category });
    prepare(state, source, copy);
    preserveState(context, state);
    await assertDetails(state, copy, language, true);
    const response = await state.get(surface.path(language));
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(surface.slugs(response.body), [copy.slug]);
    if (surface.counted) assert.equal(response.body.data.total, 1);
  });
}

const CONFLICTS = [
  ['different canonical IDs with matching display keys', (state, source, copy) => {
    const foreign = {
      ...structuredClone(source), _id: id(9000), sourceArticleId: id(9000),
      slug: 'foreign-canonical', slugs: { en: 'foreign-canonical' },
    };
    state.rows.News.push(foreign);
    copy.sourceArticleId = foreign._id;
  }],
  ['CMS and copy group keys disagree', (_state, _source, copy) => {
    copy.translationKey = 'wrong-group';
    copy.translationGroupId = 'wrong-group';
  }],
  ['nested CMS source contradicts the top-level source', (_state, source) => {
    source.translationMeta = { sourceArticleId: id(9000) };
  }],
  ['missing declared canonical source', (_state, source, copy) => {
    source.sourceArticleId = id(9000);
    copy.sourceArticleId = id(9000);
  }],
];
for (const language of LANGUAGES) for (const surface of SURFACES) for (const [label, prepare] of CONFLICTS) {
  test(`${language} ${surface.name} excludes ${label}`, async context => {
    const state = install(context);
    const { source, copy } = seed(state, 'visible', language, { category: surface.category });
    prepare(state, source, copy);
    preserveState(context, state);
    const detail = await state.get(`/api/public/stories/${copy.slug}?lang=${language}`);
    assert.equal(detail.status, 404, detail.text);
    const response = await state.get(surface.path(language));
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(surface.slugs(response.body), []);
    if (surface.counted) assert.equal(response.body.data.total, 0);
  });
}

for (const language of LANGUAGES) for (const surface of SURFACES) {
  test(`${language} ${surface.name} preserves group-key-only public content without CMS lookup`, async context => {
    const state = install(context);
    const { copy } = seed(state, 'public-only', language, { category: surface.category });
    copy.translationKey = 'historical-public-only';
    copy.translationGroupId = 'historical-public-only';
    state.failures['News.find'] = {};
    preserveState(context, state);
    const response = await state.get(surface.path(language));
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(surface.slugs(response.body), [copy.slug]);
    assert.equal(state.calls.filter(call => call.name === 'News' && call.method === 'find').length, 0);
  });
}

for (const surface of SURFACES) {
  test(`${surface.name} does not treat unrelated legacy metadata as a public-only ownership conflict`, async context => {
    const state = install(context);
    const { copy } = seed(state, 'public-only', 'en', { category: surface.category });
    copy.translationMeta = 'historical-display-metadata';
    preserveState(context, state);
    await assertDetails(state, copy, 'en', true);
    const response = await state.get(surface.path('en'));
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(surface.slugs(response.body), [copy.slug]);
  });

  test(`${surface.name} rechecks parent withdrawal on the next uncached listing request`, async context => {
    const state = install(context);
    const { source, copy } = seed(state, 'visible', 'en', { category: surface.category });
    const first = await state.get(surface.path('en'));
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(surface.slugs(first.body), [copy.slug]);
    source.status = 'deleted';
    source.deletedAt = new Date();
    preserveState(context, state);
    const withdrawn = await state.get(surface.path('en'));
    assert.equal(withdrawn.status, 200, withdrawn.text);
    assert.deepEqual(surface.slugs(withdrawn.body), []);
    if (surface.counted) assert.equal(withdrawn.body.data.total, 0);
  });
}

for (const surface of [SURFACES[0], SURFACES[2], SURFACES[3], SURFACES[5]]) {
  test(`${surface.name} closes the candidate cursor after a parent lookup failure`, async context => {
    const state = install(context);
    seed(state, 'visible', 'en', { category: surface.category });
    state.failures['News.find'] = {};
    preserveState(context, state);
    const response = await state.get(surface.path('en'));
    assert.ok([500, 503].includes(response.status), response.text);
    const cursors = state.calls.filter(call => call.name === 'Article' && call.method === 'cursor');
    assert.equal(cursors.length, 1);
    assert.equal(cursors[0].closed, true);
  });
}

test('Regional page changes fail explicitly instead of returning a short page with a stale total', async context => {
  const state = install(context);
  const { source } = seed(state, 'visible', 'en');
  const find = Article.find;
  context.mock.method(Article, 'find', (filter, ...args) => {
    if (filter.$and?.some(clause => clause._id?.$in)) {
      source.status = 'deleted';
      source.deletedAt = new Date();
    }
    return find(filter, ...args);
  });
  const response = await state.get(SURFACES[2].path('en', 1, 1));
  assert.equal(response.status, 503, response.text);
  assert.equal(response.body.success, false);
  assert.match(response.body.message, /Public listing changed/);
  assert.equal(state.invalidations.length, 0);
  assert.equal(state.calls.some(call => ['updateOne', 'updateMany', 'save'].includes(call.method)), false);
});

test('stories returns HTTP 400 for invalid listing pagination', async context => {
  const state = install(context);
  seed(state, 'visible', 'en');
  preserveState(context, state);
  const response = await state.get(SURFACES[0].path('en', 1, -1));
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { success: false, message: 'Invalid public listing pagination' });
  assert.equal(state.calls.some(call => ['Article', 'News'].includes(call.name)), false);
});

for (const surface of [SURFACES[0], SURFACES[5]]) {
  test(`${surface.name} returns HTTP 503 when page ownership changes`, async context => {
    const state = install(context);
    const { source } = seed(state, 'visible', 'en', { category: surface.category });
    const copies = structuredClone(state.rows.Article);
    const find = Article.find;
    context.mock.method(Article, 'find', (filter, ...args) => {
      if (filter.$and?.some(clause => clause._id?.$in)) {
        source.status = 'deleted';
        source.deletedAt = new Date();
      }
      return find(filter, ...args);
    });
    const response = await state.get(surface.path('en', 1, 1));
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, surface === SURFACES[0]
      ? { success: false, message: 'Public listing changed or timed out. Retry the request.' }
      : { ok: false, code: 'SERVER_ERROR', message: 'Failed to load national live ticker' });
    assert.deepEqual(state.rows.Article, copies);
    assert.equal(state.invalidations.length, 0);
    assert.equal(state.rows.TranslationJob.length, 0);
    assert.equal(state.calls.some(call => ['updateOne', 'updateMany', 'save'].includes(call.method)), false);
  });
}

for (const surface of [SURFACES[0], SURFACES[1], SURFACES[5]]) {
  test(`${surface.name} hides private listing error details`, async context => {
    const state = install(context);
    seed(state, 'visible', 'en', { category: surface.category });
    preserveState(context, state);
    const privateDetail = 'SYNTHETIC_PRIVATE_LISTING_ERROR';
    const messages = {
      400: 'Invalid public listing pagination',
      503: 'Public listing changed or timed out. Retry the request.',
      500: 'Failed to load stories',
    };
    for (const [statusCode, expectedStatus] of [[undefined, 500], [400, 400], [503, 503], [200, 500]]) {
      state.failures['News.find'] = { statusCode, message: privateDetail, code: privateDetail, stack: privateDetail };
      const response = await state.get(surface.path('en'));
      assert.equal(response.status, expectedStatus);
      assert.equal(response.text.includes(privateDetail), false);
      assert.deepEqual(response.body, surface === SURFACES[5]
        ? { ok: false, code: 'SERVER_ERROR', message: 'Failed to load national live ticker' }
        : { success: false, message: messages[expectedStatus] });
    }
  });
}

test('An edition-only link verifies its nested canonical relationship in a second bounded CMS batch', async context => {
  const state = install(context);
  const { source, copy } = seed(state, 'deleted-representative', 'en');
  const owner = state.rows.News.find(doc => doc._id === copy.sourceNewsId);
  owner.status = 'published';
  owner.deletedAt = null;
  owner.translationMeta = { sourceArticleId: source._id };
  delete owner.sourceArticleId;
  delete copy.sourceArticleId;
  preserveState(context, state);
  const response = await state.get(SURFACES[1].path('en'));
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(SURFACES[1].slugs(response.body), [copy.slug]);
  const ids = News.find.mock.calls.map(call => call.arguments[0]._id.$in);
  assert.ok(ids.some(values => values.length === 1 && values[0] === owner._id));
  assert.ok(ids.some(values => values.length === 1 && values[0] === source._id));
});

test('A cursor cleanup failure does not mask the original candidate database failure', async context => {
  const state = install(context);
  const find = Article.find;
  context.mock.method(Article, 'find', (...args) => {
    const query = find(...args);
    query.cursor = () => ({
      next: async () => { throw Object.assign(new Error('Synthetic candidate lookup failed'), { name: 'MongoNetworkError' }); },
      close: async () => { throw Object.assign(new Error('Synthetic cursor cleanup failed'), { statusCode: 400 }); },
    });
    return query;
  });
  const warnings = [];
  context.mock.method(console, 'warn', (...args) => warnings.push(args));
  preserveState(context, state);
  const response = await state.get(SURFACES[0].path('en'));
  assert.equal(response.status, 500);
  assert.equal(response.body.success, false);
  assert.equal(response.body.message, 'Failed to load stories');
  assert.doesNotMatch(response.text, /Synthetic candidate|Synthetic cursor/);
  assert.ok(warnings.some(([message]) => message.includes('cursor cleanup failed')));
});

for (const surface of [SURFACES[0], SURFACES[2], SURFACES[3], SURFACES[5]]) for (const hidden of [0, 205]) {
  test(`${surface.name} validates bounded identity batches before selection with ${hidden} hidden candidates`, async context => {
    const state = install(context);
    for (let index = 1; index <= 245; index += 1) {
      seed(state, index <= hidden ? 'deleted' : 'visible', 'en', { index, category: surface.category });
    }
    preserveState(context, state);
    const response = await state.get(surface.path('en', 1, 5));
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(surface.slugs(response.body), [1, 2, 3, 4, 5].map(index => `visibility-story-${hidden + index}`));
    if (surface.counted) assert.equal(response.body.data.total, 245 - hidden);
    const cursors = state.calls.filter(call => call.name === 'Article' && call.method === 'cursor');
    assert.equal(cursors.length, 1, 'Use one streaming candidate query, not repeated offset queries');
    assert.equal(cursors[0].closed, true);
    assert.ok(cursors[0].options.batchSize <= 100);
    assert.equal(cursors[0].selection.split(/\s+/).includes('content'), false);
    const scanned = surface.counted || hidden ? 245 : 100;
    assert.equal(cursors[0].readCount, scanned, 'Limited feeds stop without scanning the remaining eligible records');
    const lookups = state.calls.filter(call => call.name === 'News' && call.method === 'find');
    assert.equal(lookups.length, Math.ceil(scanned / 100) + 1, 'One parent batch per 100 candidates plus page revalidation');
    for (const call of lookups) {
      assert.ok(call.filter._id.$in.length <= 200, 'CMS reads must be bounded _id batches');
      assert.ok(call.options.maxTimeMS > 0 && call.options.maxTimeMS <= 2500);
    }
    assert.equal(state.calls.some(call => call.name === 'News' && ['findOne', 'findById'].includes(call.method)), false);
  });
}

test('group winner selection excludes a hidden native sibling before preferring it to a visible translation', async context => {
  const state = install(context);
  const { source, copy } = seed(state, 'visible', 'en');
  const { source: hidden, copy: hiddenCopy } = seed(state, 'hidden', 'hi', { index: 2, hoursAgo: 0.1 });
  for (const doc of [hidden, hiddenCopy]) {
    doc.sourceArticleId = source._id;
    doc.sourceLanguage = 'en';
    doc.translationKey = source.translationKey;
    doc.translationGroupId = source.translationGroupId;
  }
  preserveState(context, state);
  const response = await state.get(SURFACES[1].path('hi', 1, 1));
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(SURFACES[1].slugs(response.body), [copy.slug]);
  assert.equal(response.body.data[0].title, copy.translations.hi.title);
});

const DETAIL_SURFACES = [
  {
    name: 'story slug',
    path: (copy, lang) => `/api/public/stories/${copy.slugs[lang]}?lang=${lang}`,
    article: body => body.data,
    absentStatus: 404, absentBody: { success: false, message: 'Story not found' },
  },
  {
    name: 'article ID',
    path: (copy, lang) => `/api/articles/${copy._id}?lang=${lang}`,
    article: body => body.article,
    absentStatus: 404, absentBody: { ok: false, success: false, status: 404, message: 'Article not found' },
  },
  ...['slug', 'by-slug'].map(alias => ({
    name: `article ${alias}`,
    path: (copy, lang) => `/api/articles/${alias}/${copy.slugs[lang]}?lang=${lang}`,
    article: body => body,
    absentStatus: 200, absentBody: { exists: false },
  })),
  ...['ID', 'slug'].map(kind => ({
    name: `public news ${kind}`, resolvesCms: true,
    path: (copy, lang) => `/api/public/news/${kind === 'ID' ? copy._id : copy.slugs[lang]}?lang=${lang}`,
    article: body => body,
    absentStatus: 404, absentBody: { message: 'Not found' },
  })),
];

const DETAIL_CASES = [
  ...CASES,
  { name: 'deleted shared representative despite a visible canonical', mode: 'deleted-representative', visible: false },
  ...COMPATIBILITY.map(([name, prepare]) => ({ name, prepare, mode: 'deleted-representative', visible: true })),
  ...CONFLICTS.map(([name, prepare]) => ({ name, prepare, mode: 'visible', visible: false })),
  ...['visible', 'deleted', 'hidden', 'missing'].map(mode => ({
    name: `nested-only ${mode} parent`, mode, visible: mode === 'visible',
    prepare(_state, source, copy) {
      copy.translationMeta = { sourceArticleId: source._id };
      copy.sourceNewsId = null;
      copy.sourceArticleId = null;
    },
  })),
  {
    name: 'conflicting top-level and nested copy sources', mode: 'visible', visible: false,
    prepare(_state, _source, copy) { copy.translationMeta = { sourceArticleId: id(9000) }; },
  },
  {
    name: 'conflicting public-copy group keys', mode: 'contradictory', visible: false,
  },
  ...['deleted', 'private'].map(status => ({
    name: `visible owner with a contradictory ${status} canonical`, mode: 'visible', visible: false,
    prepare(state, source, copy) {
      const foreign = { ...structuredClone(source), _id: id(9000), sourceArticleId: id(9000) };
      if (status === 'deleted') Object.assign(foreign, { status: 'deleted', deletedAt: new Date(NOW - HOUR) });
      else foreign.visibility = 'private';
      state.rows.News.push(foreign);
      copy.sourceArticleId = foreign._id;
    },
  })),
  {
    name: 'group-key-only historical public copy', mode: 'public-only', visible: true,
    prepare(_state, _source, copy) {
      copy.translationKey = 'historical-public-only';
      copy.translationGroupId = 'historical-public-only';
    },
  },
];

function installDetailState(context, scenario) {
  const state = install(context);
  const { source, copy } = seed(state, scenario.mode, 'en');
  if (scenario.canonicalOnly) copy.sourceNewsId = null;
  if (scenario.prepare) scenario.prepare(state, source, copy);
  // Normally force the fallback; native CMS checks deliberately share the slug.
  copy.slug = scenario.sharedSlug ? source.slug : 'direct-public-copy';
  copy.slugs = Object.fromEntries(LANGUAGES.map(lang => [
    lang, scenario.sharedSlug ? source.slugs[lang] : `direct-public-copy-${lang}`,
  ]));
  for (const doc of [...state.rows.News, copy]) {
    const marker = doc === copy ? 'PUBLIC_COPY' : 'CMS_CONTENT';
    for (const lang of LANGUAGES) {
      Object.assign(doc.translations[lang], {
        title: `${marker}_${lang}_title`,
        summary: `${marker}_${lang}_summary`,
        content: `<p>${marker}_${lang}_persisted_body</p>`,
      });
    }
    doc.title = doc.translations[doc.language].title;
    doc.summary = doc.description = doc.translations[doc.language].summary;
    doc.content = doc.translations[doc.language].content;
  }
  preserveState(context, state);
  context.after(() => assert.equal(state.calls.some(call => [
    'save', 'create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteMany', 'deleteOne',
  ].includes(call.method)), false, 'Detail eligibility must not attempt writes, repairs or translation generation'));
  return { state, source, copy };
}

for (const language of LANGUAGES) for (const scenario of DETAIL_CASES) for (const surface of DETAIL_SURFACES) {
  test(`${language} direct safety ${surface.name}: ${scenario.name}`, async context => {
    const { state, copy } = installDetailState(context, scenario);
    const response = await state.get(surface.path(copy, language));
    if (!scenario.visible) {
      assert.equal(response.status, surface.absentStatus, response.text);
      assert.deepEqual(response.body, surface.absentBody);
      assert.doesNotMatch(response.text, /PUBLIC_COPY_|CMS_CONTENT_/);
    } else {
      assert.equal(response.status, 200, response.text);
      const article = surface.article(response.body);
      const resolvesCms = surface.resolvesCms && copy.sourceNewsId;
      const marker = resolvesCms ? 'CMS_CONTENT' : 'PUBLIC_COPY';
      assert.equal(article.title, `${marker}_${language}_title`);
      assert.ok(JSON.stringify(article).includes(`${marker}_${language}_persisted_body`));
      assert.equal(Object.hasOwn(article, 'translationMeta'), false);
      if (!resolvesCms) assert.equal(String(article._id), copy._id);
      else assert.ok(state.rows.News.some(doc => doc._id === String(article._id) && doc.status === 'published'));
    }

    const ownershipReads = state.calls.filter(call => call.name === 'News' && call.method === 'find' && call.filter._id?.$in);
    assert.ok(ownershipReads.length <= 2, 'One detail may perform at most two bounded ownership reads');
    for (const call of ownershipReads) {
      assert.ok(call.filter._id.$in.length <= 2);
      assert.ok(call.options.maxTimeMS > 0 && call.options.maxTimeMS <= 2500);
    }
    const listing = await state.get(SURFACES[1].path(language));
    assert.equal(listing.status, 200, listing.text);
    assert.deepEqual(SURFACES[1].slugs(listing.body), scenario.visible ? [copy.slugs[language]] : []);
  });
}

for (const [name, patch] of HIDDEN_PARENT_PATCHES) for (const surface of DETAIL_SURFACES) {
  test(`direct safety ${surface.name} excludes ${name} without returning persisted content`, async context => {
    const { state, copy } = installDetailState(context, {
      mode: 'visible', prepare: (_state, source) => Object.assign(source, structuredClone(patch)),
    });
    const response = await state.get(surface.path(copy, 'en'));
    assert.equal(response.status, surface.absentStatus, response.text);
    assert.deepEqual(response.body, surface.absentBody);
    assert.doesNotMatch(response.text, /PUBLIC_COPY_|CMS_CONTENT_/);
  });
}

for (const failureAt of ['owner', 'canonical']) for (const surface of DETAIL_SURFACES) {
  test(`direct safety ${surface.name} surfaces ${failureAt} lookup failures, not absence`, async context => {
    const { state, source, copy } = installDetailState(context, {
      mode: 'deleted-representative',
      prepare(rows, _source, publicCopy) {
        Object.assign(rows.rows.News.find(doc => doc._id === publicCopy.sourceNewsId), { status: 'published', deletedAt: null });
        publicCopy.sourceArticleId = null;
      },
    });
    const failureId = failureAt === 'owner' ? copy.sourceNewsId : source._id;
    const find = News.find;
    context.mock.method(News, 'find', (filter, ...args) => {
      if (filter._id?.$in?.includes(failureId)) {
        throw Object.assign(new Error('Synthetic parent lookup failure'), { name: 'MongoNetworkError' });
      }
      return find(filter, ...args);
    });
    const response = await state.get(surface.path(copy, 'en'));
    assert.ok([500, 503].includes(response.status), response.text);
    assert.doesNotMatch(response.text, /PUBLIC_COPY_|CMS_CONTENT_/);
  });
}

for (const surface of DETAIL_SURFACES.filter(item => item.name !== 'story slug')) {
  test(`direct safety ${surface.name} preserves an independently visible CMS detail despite a conflicting shared-slug copy`, async context => {
    const { state, source, copy } = installDetailState(context, { mode: 'contradictory', sharedSlug: true });
    const nativeLookup = { ...copy, _id: source._id, slugs: source.slugs };
    const response = await state.get(surface.path(nativeLookup, 'en'));
    assert.equal(response.status, 200, response.text);
    const article = surface.article(response.body);
    assert.equal(article.title, source.title);
    assert.ok(JSON.stringify(article).includes('CMS_CONTENT_en_persisted_body'));
    assert.doesNotMatch(response.text, /PUBLIC_COPY_/);
    assert.equal(String(article._id), source._id);
  });
}

for (const scenario of [
  { name: 'source-less historical copy', mode: 'public-only', reads: 0 },
  { name: 'self-canonical visible owner', mode: 'visible', reads: 1 },
  {
    name: 'visible child with an inferred draft canonical', mode: 'deleted-representative', reads: 2,
    prepare(state, source, copy) {
      Object.assign(state.rows.News.find(doc => doc._id === copy.sourceNewsId), { status: 'published', deletedAt: null });
      source.status = 'draft';
      copy.sourceArticleId = null;
    },
  },
]) {
  test(`direct safety uses exactly ${scenario.reads} bounded ownership reads for ${scenario.name}`, async context => {
    const { state, source, copy } = installDetailState(context, scenario);
    assert.equal(await hasVisibleNewsSource(copy), true);
    const reads = state.calls.filter(call => call.name === 'News' && call.method === 'find');
    assert.equal(reads.length, scenario.reads);
    const expectedIds = scenario.reads === 0 ? [] : scenario.reads === 1 ? [[source._id]] : [[copy.sourceNewsId], [source._id]];
    assert.deepEqual(reads.map(call => call.filter._id.$in), expectedIds);
    for (const call of reads) assert.ok(call.options.maxTimeMS > 0 && call.options.maxTimeMS <= 2500);
  });
}

for (const surface of DETAIL_SURFACES) {
  test(`direct safety ${surface.name} cannot bypass a nested withdrawal through language fallback or generation`, async context => {
    const { state, copy } = installDetailState(context, {
      mode: 'deleted',
      prepare(_state, source, publicCopy) {
        Object.assign(publicCopy, {
          sourceNewsId: null, sourceArticleId: null, translationMeta: { sourceArticleId: source._id },
        });
        publicCopy.translationStatus.gu = 'pending';
      },
    });
    const previousAuto = process.env.ENABLE_AUTO_TRANSLATE_ON_READ;
    process.env.ENABLE_AUTO_TRANSLATE_ON_READ = 'true';
    context.after(() => {
      if (previousAuto === undefined) delete process.env.ENABLE_AUTO_TRANSLATE_ON_READ;
      else process.env.ENABLE_AUTO_TRANSLATE_ON_READ = previousAuto;
    });
    const response = await state.get(`${surface.path(copy, 'gu')}&fallback=true`);
    assert.equal(response.status, surface.absentStatus, response.text);
    assert.deepEqual(response.body, surface.absentBody);
    assert.doesNotMatch(response.text, /PUBLIC_COPY_|CMS_CONTENT_/);
  });
}
