const isolation = require('./helpers/adminPutIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Article = require('../models/Article');
const News = require('../models/News');
const SponsoredFeature = require('../models/SponsoredFeature');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const SiteSettings = require('../models/SiteSettings');
const Role = require('../models/Role');
const backgroundTasks = require('../lib/backgroundTasks');
const { installEditorialFixture, seedGroup, matches } = require('./helpers/editorialLifecycleFixture');
const {
  LINKED_ARTICLE_SELECT, findLinkedArticleByAnyId, getActiveSponsoredFeatureByPlacement,
} = require('../services/sponsoredFeatures.service');
const { PUBLIC_LISTING_IDENTITY_FIELDS } = require('../services/publicArticleListing.service');

test.after(() => isolation.assertNoSideEffects());

const LANGUAGES = ['gu', 'hi', 'en'];
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const id = value => value.toString(16).padStart(24, '0');
const PUBLIC_PATHS = [
  '/api/public/sponsored-feature?placement=homepage',
  '/api/public/sponsored-features?placementKey=HOMEPAGE_SPONSORED_FEATURE',
  '/api/public/sponsored-features/slot/homepage',
];
const withLang = (path, lang) => `${path}${path.includes('?') ? '&' : '?'}lang=${lang}`;
const articlePath = copy => `/news/${encodeURIComponent(copy.slug)}`;
const writeMethods = [
  'save', 'create', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate',
  'findByIdAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'findByIdAndDelete', 'bulkWrite',
];

function install(context, { language = 'en', prepare } = {}) {
  const state = installEditorialFixture(context);
  const previousDb = mongoose.connection.db;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.db = previousDb; });
  context.mock.method(PublicSiteSettings, 'getOrCreate', async () => ({
    published: { languageTheme: { languages: LANGUAGES } },
  }));
  seedGroup(state);
  const source = state.rows.News[0];
  const copy = state.rows.Article[0];
  state.rows.News = [source];
  state.rows.Article = [copy];
  for (const doc of [source, copy]) {
    const marker = doc === copy ? 'COPY' : 'CMS';
    const translations = Object.fromEntries(LANGUAGES.map(lang => [lang, {
      title: `${marker}_${lang}_TITLE`,
      summary: `${marker}_${lang}_SUMMARY`,
      content: `<p>${marker}_${lang}_BODY</p>`,
      provider: 'manual', generatedAt: new Date(NOW - HOUR),
    }]));
    Object.assign(doc, {
      language, lang: language, originalLang: language, sourceLanguage: language,
      slug: `${marker.toLowerCase()}-story-${language}`,
      slugs: Object.fromEntries(LANGUAGES.map(lang => [lang, `${marker.toLowerCase()}-story-${lang}`])),
      translations, translationStatus: Object.fromEntries(LANGUAGES.map(lang => [lang, 'ready'])),
      title: translations[language].title, summary: translations[language].summary,
      description: translations[language].summary, content: translations[language].content,
      publishedAt: new Date(NOW - HOUR), createdAt: new Date(NOW - 2 * HOUR), updatedAt: new Date(NOW - HOUR),
      category: 'national', isSponsored: true, isSponsoredArticle: true,
      sponsorName: 'Article sponsor', sponsorFeatureEligible: true, sponsorFeatureLinkedId: id(4001),
    });
  }
  const feature = {
    _id: id(4001), type: 'sponsored_feature',
    placementKey: 'HOMEPAGE_SPONSORED_FEATURE', placement: 'homepage_sponsored_feature',
    labelText: 'Paid placement', sponsorName: 'Independent sponsor', internalTitle: 'Independent campaign',
    headline: 'AD_HEADLINE', summary: 'AD_SUMMARY', ctaText: 'Visit sponsor',
    coverImage: { url: 'https://ads.example/banner.jpg', alt: 'AD_IMAGE', publicId: 'ad-banner' },
    destinationUrl: 'https://sponsor.example/landing?campaign=paid',
    linkedArticleId: copy._id, comboCampaign: { isActive: true }, isActive: true,
    startAt: null, endAt: null, priority: 5, createdAt: new Date(NOW - 2 * HOUR), updatedAt: new Date(NOW - HOUR),
  };
  state.rows.SponsoredFeature = [feature];
  if (prepare) prepare(state, source, copy, feature);

  const featureQuery = (method, filter, single) => {
    let fields;
    let limit = Infinity;
    return {
      select(value) { fields = value.split(/\s+/); return this; },
      sort() { return this; },
      limit(value) { limit = value; return this; },
      async lean() {
        state.calls.push({ name: 'SponsoredFeature', method, filter, limit });
        if (state.failures[`SponsoredFeature.${method}`]) {
          throw Object.assign(new Error('Synthetic sponsorship lookup failure'), { name: 'MongoNetworkError' });
        }
        const rows = state.rows.SponsoredFeature.filter(doc => matches(doc, filter)).slice(0, limit);
        const project = doc => !doc ? null : structuredClone(fields
          ? Object.fromEntries(Object.entries(doc).filter(([key]) => key === '_id' || fields.includes(key)))
          : doc);
        return single ? project(rows[0]) : rows.map(project);
      },
    };
  };
  context.mock.method(SponsoredFeature, 'find', filter => featureQuery('find', filter || {}, false));
  context.mock.method(SponsoredFeature, 'findById', value => featureQuery('findById', { _id: value }, true));
  let sponsorWrites = 0;
  const rejectSponsorWrite = () => {
    sponsorWrites += 1;
    assert.fail('Read-only sponsorship lookup attempted a write');
  };
  for (const method of writeMethods.filter(value => value !== 'save')) {
    context.mock.method(SponsoredFeature, method, rejectSponsorWrite);
  }
  context.mock.method(SponsoredFeature.prototype, 'save', rejectSponsorWrite);

  state.articleSelections = [];
  const findArticle = Article.findOne;
  context.mock.method(Article, 'findOne', (...args) => {
    const query = findArticle(...args);
    const select = query.select.bind(query);
    query.select = value => {
      state.articleSelections.push(value);
      return select(value);
    };
    return query;
  });
  const before = structuredClone(state.rows);
  context.after(() => {
    assert.deepEqual(state.rows, before, 'Reads must preserve news, copies, ads, destinations and chronology');
    assert.equal(sponsorWrites, 0);
    assert.equal(state.calls.some(call => writeMethods.includes(call.method)), false);
    assert.equal(state.invalidations.length, 0);
    assert.equal(state.transactions.length, 0);
  });
  state.get = path => state.request('get', path, undefined, null).timeout({ response: 5000, deadline: 6000 });
  return { state, source, copy, feature };
}

function addSharedOwner(state, source, copy) {
  const language = LANGUAGES.find(lang => lang !== source.language);
  const owner = {
    ...structuredClone(source), _id: id(2001),
    language, lang: language, originalLang: language,
    title: source.translations[language].title, description: source.translations[language].summary,
    summary: source.translations[language].summary, content: source.translations[language].content,
    slug: `cms-shared-${language}`, slugs: { [language]: `cms-shared-${language}` },
  };
  state.rows.News.push(owner);
  copy.sourceNewsId = owner._id;
  return owner;
}

const CONFLICTS = [
  {
    name: 'contradictory canonical with matching group keys',
    prepare(state, source, copy) {
      const foreign = { ...structuredClone(source), _id: id(3001), sourceArticleId: id(3001) };
      state.rows.News.push(foreign);
      copy.sourceArticleId = foreign._id;
    },
  },
  {
    name: 'copy group differs from persisted owner',
    prepare(_state, _source, copy) { copy.translationKey = copy.translationGroupId = 'different-group'; },
  },
  {
    name: 'contradictory copy group keys',
    prepare(_state, _source, copy) { copy.translationGroupId = 'different-group'; },
  },
  {
    name: 'contradictory nested copy source',
    prepare(_state, _source, copy) { copy.translationMeta = { sourceArticleId: id(3001) }; },
  },
  {
    name: 'contradictory nested owner source',
    prepare(_state, source) { source.translationMeta = { sourceArticleId: id(3001) }; },
  },
  {
    name: 'missing declared canonical',
    prepare(_state, source, copy) { source.sourceArticleId = copy.sourceArticleId = id(3001); },
  },
];
const COMPATIBLE = [
  { name: 'verified published owner' },
  { name: 'verified shared owner', prepare: addSharedOwner },
  {
    name: 'published child with a draft canonical',
    prepare(state, source, copy) { addSharedOwner(state, source, copy); source.status = 'draft'; },
  },
  { name: 'canonical-only copy', prepare(_state, _source, copy) { copy.sourceNewsId = null; } },
  {
    name: 'nested-only canonical copy',
    prepare(_state, source, copy) {
      copy.sourceNewsId = copy.sourceArticleId = null;
      copy.translationMeta = { sourceArticleId: source._id };
    },
  },
  {
    name: 'source-less historical copy',
    prepare(state, _source, copy) {
      state.rows.News = [];
      copy.sourceNewsId = copy.sourceArticleId = copy.translationKey = copy.translationGroupId = null;
    },
  },
  {
    name: 'source-less cached translation group',
    prepare(state, _source, copy) {
      state.rows.News = [];
      copy.sourceNewsId = copy.sourceArticleId = null;
    },
  },
  {
    name: 'missing optional canonical links and group keys',
    prepare(_state, source, copy) {
      for (const doc of [source, copy]) {
        delete doc.sourceArticleId;
        delete doc.translationGroupId;
        delete doc.translationKey;
      }
    },
  },
];
const HIDDEN_PARENTS = [
  ['deleted owner', { status: 'deleted', deletedAt: new Date(NOW - HOUR) }],
  ['deletion-marked owner', { deletedAt: new Date(NOW - HOUR) }],
  ['unpublished owner', { status: 'draft' }],
  ['private owner', { visibility: 'private' }],
  ['isPrivate owner', { isPrivate: true }],
  ['locked owner', { locked: true }],
  ['workflow-hidden owner', { workflow: { locked: true } }],
  ['embargoed owner', { embargoUntil: new Date(NOW + HOUR) }],
  ['scheduled owner', { scheduledAt: new Date(NOW + HOUR) }],
];
const INELIGIBLE = [
  ...HIDDEN_PARENTS.map(([name, patch]) => ({
    name, prepare(_state, source) { Object.assign(source, structuredClone(patch)); },
  })),
  { name: 'missing declared owner', prepare(state) { state.rows.News = []; } },
  { name: 'missing public copy', prepare(state) { state.rows.Article = []; } },
  {
    name: 'deleted shared owner with published canonical',
    prepare(state, source, copy) {
      Object.assign(addSharedOwner(state, source, copy), { status: 'deleted', deletedAt: new Date(NOW - HOUR) });
    },
  },
  {
    name: 'private canonical-only source',
    prepare(_state, source, copy) { copy.sourceNewsId = null; source.visibility = 'private'; },
  },
  {
    name: 'nested-only deleted source',
    prepare(_state, source, copy) {
      copy.sourceNewsId = copy.sourceArticleId = null;
      copy.translationMeta = { sourceArticleId: source._id };
      source.status = 'deleted';
    },
  },
  ...CONFLICTS,
  ...['deleted', 'draft', 'private', 'locked'].map(mode => ({
    name: `${mode} public copy`,
    prepare(_state, _source, copy) {
      if (mode === 'private') copy.visibility = 'private';
      else if (mode === 'locked') copy.locked = true;
      else copy.status = mode;
    },
  })),
];

function expectedFeature(feature, copy, eligible) {
  return {
    label: feature.labelText, sponsorName: feature.sponsorName, headline: feature.headline,
    summary: feature.summary, ctaText: feature.ctaText, coverImage: feature.coverImage,
    targetType: eligible ? 'linked_article' : feature.destinationUrl ? 'external_url' : null,
    targetUrl: eligible ? articlePath(copy) : feature.destinationUrl,
    linkedArticle: eligible ? { slug: copy.slug, path: articlePath(copy) } : null,
  };
}

for (const language of LANGUAGES) for (const scenario of [
  ...COMPATIBLE.map(value => ({ ...value, eligible: true })),
  ...INELIGIBLE.map(value => ({ ...value, eligible: false })),
]) for (const path of PUBLIC_PATHS) {
  test(`${language} sponsored link ${scenario.name}: ${path}`, async context => {
    const { state, copy, feature } = install(context, { language, prepare: scenario.prepare });
    const response = await state.get(withLang(path, language));
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body, {
      ok: true, placementKey: 'HOMEPAGE_SPONSORED_FEATURE', placement: 'homepage_sponsored_feature',
      feature: expectedFeature(feature, copy, scenario.eligible),
    });
    assert.doesNotMatch(response.text, /COPY_.*_(TITLE|SUMMARY|BODY)|CMS_.*_(TITLE|SUMMARY|BODY)/);
    if (!scenario.eligible) assert.ok(!response.text.includes(copy.slug));
    assert.match(response.headers['cache-control'], /no-store/);
    const reads = state.calls.filter(call => call.name === 'News' && call.method === 'find');
    assert.ok(reads.length <= 2);
    for (const call of reads) {
      assert.ok(call.filter._id.$in.length <= 2);
      assert.ok(call.options.maxTimeMS > 0 && call.options.maxTimeMS <= 2500);
    }
    assert.equal(state.calls.filter(call => call.name === 'Article' && call.method === 'findOne').length, 1);
    assert.equal(state.calls.find(call => call.name === 'SponsoredFeature' && call.method === 'find').limit, 50);
  });
}

for (const scenario of [COMPATIBLE[0], ...CONFLICTS]) for (const language of LANGUAGES) {
  for (const kind of ['ID', 'slug']) {
    test(`${language} News ${kind} enrichment: ${scenario.name}`, async context => {
      const { state, source, copy, feature } = install(context, {
        prepare(state, source, copy, feature) {
          if (scenario.prepare) scenario.prepare(state, source, copy, feature);
          feature.linkedArticleId = source._id;
        },
      });
      const path = kind === 'ID' ? `/api/public/news/${source._id}` : `/api/public/news/slug/${source.slug}`;
      const response = await state.get(withLang(path, language));
      assert.equal(response.status, 200, response.text);
      assert.equal(String(response.body._id), source._id);
      assert.equal(response.body.title, source.translations[language].title);
      assert.equal(response.body.content, source.translations[language].content);
      if (!scenario.prepare) {
        assert.equal(response.body.linkedSponsoredFeature.id, feature._id);
        assert.equal(response.body.linkedSponsoredFeature.linkedArticleSlug, copy.slug);
        assert.equal(response.body.linkedSponsoredFeature.linkedArticlePath, articlePath(copy));
      } else {
        assert.equal(Object.hasOwn(response.body, 'linkedSponsoredFeature'), false);
        assert.ok(!response.text.includes(copy.slug));
      }
      assert.doesNotMatch(response.text, /COPY_.*_(TITLE|SUMMARY|BODY)/);
    });
  }
}

for (const scenario of COMPATIBLE) for (const language of LANGUAGES) {
  test(`${language} cached sponsored detail remains available: ${scenario.name}`, async context => {
    const { state, copy } = install(context, { prepare: scenario.prepare });
    const response = await state.get(`/api/public/news/${copy.slug}?lang=${language}`);
    assert.equal(response.status, 200, response.text);
    const marker = copy.sourceNewsId ? 'CMS' : 'COPY';
    assert.equal(response.body.title, `${marker}_${language}_TITLE`);
    assert.equal(response.body.content, `<p>${marker}_${language}_BODY</p>`);
    assert.equal(response.body.resolvedLang, language);
  });
}

for (const scenario of [
  { name: 'standalone', prepare(_state, _source, _copy, feature) { feature.linkedArticleId = null; } },
  { name: 'combo disabled', prepare(_state, _source, _copy, feature) { feature.comboCampaign.isActive = false; } },
  { name: 'non-sponsored article', prepare(_state, _source, copy) { copy.isSponsored = copy.isSponsoredArticle = false; } },
]) {
  test(`${scenario.name} keeps independent advertising without ownership queries`, async context => {
    const { state, copy, feature } = install(context, { prepare: scenario.prepare });
    state.failures['News.find'] = {};
    const response = await state.get(PUBLIC_PATHS[0]);
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body.feature, expectedFeature(feature, copy, false));
    assert.equal(state.calls.filter(call => call.name === 'News' && call.method === 'find').length, 0);
  });
}

for (const destination of ['external', 'article path', 'none']) {
  test(`ineligible link preserves configured ${destination} destination without repairs`, async context => {
    const { state, copy, feature } = install(context, {
      prepare(_state, source, copy, feature) {
        source.status = 'deleted';
        if (destination === 'article path') feature.destinationUrl = articlePath(copy);
        if (destination === 'none') feature.destinationUrl = null;
      },
    });
    const response = await state.get(PUBLIC_PATHS[0]);
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body.feature, expectedFeature(feature, copy, false));
    if (destination === 'article path') {
      const detail = await state.get(`/api/public/news/${copy.slug}?lang=en`);
      assert.equal(detail.status, 404);
      assert.deepEqual(detail.body, { message: 'Not found' });
    }
  });
}

test('public metadata loads the complete shared ownership identity projection', async context => {
  const { state } = install(context);
  await getActiveSponsoredFeatureByPlacement('homepage');
  const selected = new Set(state.articleSelections[0].split(/\s+/));
  for (const field of PUBLIC_LISTING_IDENTITY_FIELDS.split(' ')) assert.ok(selected.has(field), field);
});

for (const [scenario, reads] of [
  [COMPATIBLE.find(value => value.name === 'source-less historical copy'), 0],
  [COMPATIBLE.find(value => value.name === 'source-less cached translation group'), 0],
  [COMPATIBLE[0], 1],
  [{
    name: 'owner-inferred canonical',
    prepare(state, source, copy) { addSharedOwner(state, source, copy); copy.sourceArticleId = null; },
  }, 2],
]) {
  test(`${scenario.name} uses exactly ${reads} bounded CMS ownership reads`, async context => {
    const { state, copy } = install(context, { prepare: scenario.prepare });
    const result = await getActiveSponsoredFeatureByPlacement('homepage');
    assert.equal(result.linkedArticle._id, copy._id);
    const lookups = state.calls.filter(call => call.name === 'News' && call.method === 'find');
    assert.equal(lookups.length, reads);
    for (const call of lookups) {
      assert.ok(call.filter._id.$in.length <= 2);
      assert.ok(call.options.maxTimeMS > 0 && call.options.maxTimeMS <= 2500);
    }
  });
}

test('public ownership validation uses the supplied selection time and is not cached', async context => {
  install(context, { prepare(_state, source) { source.embargoUntil = new Date(NOW + HOUR / 2); } });
  const before = await getActiveSponsoredFeatureByPlacement('homepage', { now: new Date(NOW) });
  assert.equal(before.linkedArticle, null);
  const after = await getActiveSponsoredFeatureByPlacement('homepage', { now: new Date(NOW + HOUR) });
  assert.ok(after.linkedArticle);
});

test('publicOnly:false inspection retains hidden copies without CMS ownership reads', async context => {
  const { state, copy } = install(context, {
    prepare(_state, source, copy) { source.status = 'deleted'; copy.status = 'draft'; },
  });
  state.failures['News.find'] = {};
  const inspected = await findLinkedArticleByAnyId(copy._id, { publicOnly: false });
  assert.equal(inspected._id, copy._id);
  assert.equal(inspected.title, copy.title);
  assert.equal(inspected.slug, copy.slug);
  assert.deepEqual(state.articleSelections, [LINKED_ARTICLE_SELECT]);
  assert.equal(state.calls.filter(call => call.name === 'News' && call.method === 'find').length, 0);
});

test('authenticated administrative lists retain inspection without new per-entry parent queries', async context => {
  const { state, copy } = install(context, {
    prepare(state, source, _copy, feature) {
      source.visibility = 'private';
      for (let index = 1; index < 4; index += 1) {
        state.rows.SponsoredFeature.push({ ...structuredClone(feature), _id: id(4001 + index) });
      }
    },
  });
  state.failures['News.find'] = {};
  const response = await state.request('get', '/api/admin/sponsored-features', undefined, 'founder');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.items.length, 4);
  for (const item of response.body.items) assert.equal(item.linkedArticle.slug, copy.slug);
  assert.equal(state.calls.filter(call => call.name === 'News' && call.method === 'find').length, 0);
});

test('authorized administrative detail retains a draft copy while anonymous inspection is denied', async context => {
  const { state, copy, feature } = install(context, {
    prepare(_state, source, copy) { source.status = 'deleted'; copy.status = 'draft'; },
  });
  const path = `/api/admin/sponsored-features/${feature._id}`;
  const denied = await state.get(path);
  assert.equal(denied.status, 401, denied.text);
  assert.equal(state.calls.filter(call => ['News', 'Article', 'SponsoredFeature'].includes(call.name)).length, 0);
  const response = await state.request('get', path, undefined, 'founder');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.feature.linkedArticle.slug, copy.slug);
  assert.equal(response.body.feature.headline, feature.headline);
});

const ERROR_SURFACES = [
  ...PUBLIC_PATHS.map(path => ({ name: path, path: () => path })),
  { name: 'News ID enrichment', path: owner => `/api/public/news/${owner._id}?lang=${owner.language}` },
  { name: 'News slug enrichment', path: owner => `/api/public/news/slug/${owner.slug}?lang=${owner.language}` },
  { name: 'active-slot administrative preview', path: () => '/api/admin/sponsored-features/dashboard', role: 'founder' },
];

for (const stage of ['owner', 'canonical']) for (const surface of ERROR_SURFACES) {
  test(`${surface.name} propagates ${stage} lookup failures without successful empty data`, async context => {
    let owner;
    const { state, source } = install(context, {
      prepare(state, source, copy, feature) {
        owner = addSharedOwner(state, source, copy);
        copy.sourceArticleId = null;
        feature.linkedArticleId = owner._id;
      },
    });
    const failureId = stage === 'owner' ? owner._id : source._id;
    const find = News.find;
    let failedReads = 0;
    context.mock.method(News, 'find', (filter, ...args) => {
      if (filter._id?.$in?.includes(failureId)) {
        failedReads += 1;
        throw Object.assign(new Error('Synthetic parent lookup failure'), { name: 'MongoNetworkError' });
      }
      return find(filter, ...args);
    });
    const response = await state.request('get', surface.path(owner), undefined, surface.role || null)
      .timeout({ response: 5000, deadline: 6000 });
    assert.ok([500, 503].includes(response.status), response.text);
    assert.equal(failedReads, 1, 'The intended ownership lookup must actually be exercised');
    assert.doesNotMatch(response.text, /AD_HEADLINE|AD_SUMMARY|COPY_.*_(TITLE|SUMMARY|BODY)|CMS_.*_(TITLE|SUMMARY|BODY)/);
    assert.equal(Object.hasOwn(response.body, 'feature'), false);
  });
}

for (const failure of ['SponsoredFeature.find', 'Article.findOne']) for (const path of PUBLIC_PATHS) {
  test(`${path} forwards ${failure} errors to the HTTP error handler`, async context => {
    const { state } = install(context);
    state.failures[failure] = {};
    const response = await state.get(path);
    assert.ok([500, 503].includes(response.status), response.text);
    assert.equal(Object.hasOwn(response.body, 'feature'), false);
    assert.doesNotMatch(response.text, /AD_HEADLINE|AD_SUMMARY|COPY_.*_(TITLE|SUMMARY|BODY)/);
  });
}

for (const eligible of [true, false]) {
  test(`active-slot preview shares public eligibility (${eligible}) without changing inspected records`, async context => {
    const { state, copy, feature } = install(context, {
      prepare(_state, source) { if (!eligible) source.visibility = 'private'; },
    });
    const response = await state.request('get', '/api/admin/sponsored-features/dashboard', undefined, 'founder');
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.items[0].linkedArticle.slug, copy.slug);
    assert.equal(response.body.liveTarget.headline, feature.headline);
    assert.equal(response.body.liveTarget.targetUrl, eligible ? articlePath(copy) : feature.destinationUrl);
    if (eligible) assert.equal(response.body.liveTarget.linkedArticle.slug, copy.slug);
    else assert.equal(response.body.liveTarget.linkedArticle, null);
    const reads = state.calls.filter(call => call.name === 'News' && call.method === 'find' && call.options?.maxTimeMS);
    assert.equal(reads.length, 1);
  });
}

test('active-slot preview still denies unauthenticated access before reading sponsorship records', async context => {
  const { state } = install(context);
  const response = await state.get('/api/admin/sponsored-features/dashboard');
  assert.equal(response.status, 401, response.text);
  assert.equal(state.calls.filter(call => ['News', 'Article', 'SponsoredFeature'].includes(call.name)).length, 0);
});

const ADMIN_PREFIXES = ['/api/admin', '/admin-api/admin', '/admin-api/api/admin'];
const ADMIN_READS = [
  '/sponsored-features/dashboard', '/sponsored-features/eligible-articles',
  '/sponsored-features', `/sponsored-features/${id(4001)}`,
];
const ADMIN_WRITES = [
  ['post', '/sponsored-features'],
  ['put', `/sponsored-features/${id(4001)}`],
  ['patch', `/sponsored-features/${id(4001)}/toggle`],
  ['patch', `/sponsored-features/${id(4001)}/combo-toggle`],
  ['delete', `/sponsored-features/${id(4001)}`],
];
const CAMPAIGN_INPUT = {
  sponsorName: 'Independent sponsor', internalTitle: 'Access fixture campaign',
  headline: 'Paid advertisement', summary: 'Independent advertisement summary',
  ctaText: 'Visit sponsor', destinationUrl: 'https://sponsor.example/landing',
  coverImage: { url: 'https://ads.example/banner.jpg' }, placement: 'homepage',
  isActive: false,
};
const ADS_RIGHTS = ['ads_view', 'ads_manage_campaigns'];
const ADS_STAFF = {
  role: 'reporter', moduleAccessStates: { adsManager: 'enabled' },
  specialRightsConfigured: true, specialRightsOverride: ADS_RIGHTS,
};

function installAdminAccess(context, { staff, modulePolicies } = {}) {
  const state = installEditorialFixture(context, { staff });
  const previousDb = mongoose.connection.db;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.db = previousDb; });
  context.mock.method(SiteSettings, 'findOne', async () => ({
    adminModulePolicy: { version: 1, modulePolicies: { adsManager: 'available', ...modulePolicies } },
  }));
  context.mock.method(Role, 'findOne', () => ({ lean: async () => null }));
  state.rows.SponsoredFeature = [{
    ...structuredClone(CAMPAIGN_INPUT), _id: id(4001),
    type: 'sponsored_feature', placementKey: 'HOMEPAGE_SPONSORED_FEATURE',
    placement: 'homepage_sponsored_feature',
  }];
  const query = value => ({
    select() { return this; }, sort() { return this; }, limit() { return this; },
    lean: async () => structuredClone(value),
  });
  context.mock.method(SponsoredFeature, 'find', filter => {
    state.calls.push({ name: 'SponsoredFeature', method: 'find' });
    return query(state.rows.SponsoredFeature.filter(doc => matches(doc, filter)));
  });
  context.mock.method(SponsoredFeature, 'findById', value => {
    state.calls.push({ name: 'SponsoredFeature', method: 'findById' });
    return query(state.rows.SponsoredFeature.find(doc => doc._id === String(value)) || null);
  });
  for (const method of writeMethods.filter(value => !['save', 'create'].includes(value))) {
    context.mock.method(SponsoredFeature, method, () => assert.fail(`Unexpected campaign ${method}`));
  }
  context.mock.method(SponsoredFeature.prototype, 'save', () => assert.fail('Unexpected campaign save'));
  context.mock.method(SponsoredFeature, 'create', async payload => {
    state.calls.push({ name: 'SponsoredFeature', method: 'create' });
    const created = { _id: id(4001 + state.rows.SponsoredFeature.length), ...structuredClone(payload) };
    state.rows.SponsoredFeature.push(created);
    return created;
  });
  return state;
}

for (const prefix of ADMIN_PREFIXES) {
  test(`Sponsored Admin rejects unprivileged Staff across all routes at ${prefix}`, async context => {
    const state = installAdminAccess(context);
    for (const [method, path] of [...ADMIN_READS.map(path => ['get', path]), ...ADMIN_WRITES]) {
      const response = await state.request(method, `${prefix}${path}`, method === 'get' ? undefined : CAMPAIGN_INPUT, 'reporter')
        .timeout({ response: 2000, deadline: 3000 });
      assert.equal(response.status, 403, `${method} ${path}: ${response.text}`);
      assert.equal(response.body.code, 'FORBIDDEN');
    }
    assert.equal(state.calls.some(call => ['SponsoredFeature', 'Article', 'News'].includes(call.name)), false);
  });
}

for (const scenario of [
  {
    name: 'Founder keeps access despite Staff module and Special Rights restrictions',
    role: 'founder', staff: { moduleAccessStates: { adsManager: 'disabled' }, specialRightsConfigured: true, specialRightsOverride: [] },
    modulePolicies: { adsManager: 'founder_only' }, view: 200, create: 201,
  },
  {
    name: 'Ads Staff require explicit module access alongside inherited campaign rights',
    role: 'ads & revenue growth manager', staff: { moduleAccessOverride: ['ads_manager'] }, view: 200, create: 201,
  },
  {
    name: 'Founder-selected Staff rights authorize the selected Ads actions',
    staff: ADS_STAFF, view: 200, create: 201,
  },
  {
    name: 'campaign-only rights do not grant dashboard viewing',
    staff: { ...ADS_STAFF, specialRightsOverride: ['ads_manage_campaigns'] }, view: 403, create: 201,
  },
  {
    name: 'role presets alone do not grant individual Ads module access',
    role: 'ads & revenue growth manager', view: 403, create: 403,
  },
  {
    name: 'module access and stale Founder token claims do not grant Special Rights',
    role: 'founder', staff: { role: 'reporter', moduleAccessStates: { adsManager: 'enabled' } }, view: 403, create: 403,
  },
  {
    name: 'configured empty rights revoke inherited and legacy campaign permissions',
    role: 'ads & revenue growth manager',
    staff: { ...ADS_STAFF, role: 'ads & revenue growth manager', specialRightsOverride: [], permissions: ['ads_revenue.manage'] },
    view: 403, create: 403,
  },
  {
    name: 'individual module denial cannot be bypassed with valid Special Rights',
    staff: { ...ADS_STAFF, moduleAccessOverride: ['ads_manager'], moduleAccessStates: { adsManager: 'disabled' } },
    view: 403, create: 403,
  },
  {
    name: 'global Staff lock cannot be bypassed with individual Ads grants',
    staff: ADS_STAFF, modulePolicies: { adsManager: 'staff_locked' }, view: 403, create: 403,
  },
  {
    name: 'active temporary module and Special Rights grants remain effective',
    staff: {
      role: 'reporter', specialRightsConfigured: true, specialRightsOverride: [],
      temporaryAccess: [
        { moduleKey: 'ads_manager', enabled: true, expiresAt: new Date(NOW + HOUR) },
        ...ADS_RIGHTS.map(rightKey => ({ rightKey, enabled: true, expiresAt: new Date(NOW + HOUR) })),
      ],
    },
    view: 200, create: 201,
  },
  {
    name: 'expired temporary rights cannot restore revoked permanent rights',
    staff: {
      ...ADS_STAFF, specialRightsOverride: [],
      temporaryAccess: ADS_RIGHTS.map(rightKey => ({ rightKey, enabled: true, expiresAt: new Date(NOW - HOUR) })),
    },
    view: 403, create: 403,
  },
  {
    name: 'active temporary denials override permanent Ads rights',
    staff: {
      ...ADS_STAFF,
      temporaryAccess: ADS_RIGHTS.map(rightKey => ({ rightKey, enabled: false, expiresAt: new Date(NOW + HOUR) })),
    },
    view: 403, create: 403,
  },
]) {
  test(`Sponsored Admin ${scenario.name}`, async context => {
    const state = installAdminAccess(context, scenario);
    const existing = structuredClone(state.rows.SponsoredFeature);
    const role = scenario.role || 'reporter';
    const viewed = await state.request('get', '/api/admin/sponsored-features/dashboard', undefined, role)
      .timeout({ response: 2000, deadline: 3000 });
    assert.equal(viewed.status, scenario.view, viewed.text);
    const created = await state.request('post', '/api/admin/sponsored-features', CAMPAIGN_INPUT, role)
      .timeout({ response: 2000, deadline: 3000 });
    assert.equal(created.status, scenario.create, created.text);
    await backgroundTasks.waitForIdle();
    assert.equal(state.calls.filter(call => call.name === 'SponsoredFeature' && call.method === 'create').length, scenario.create === 201 ? 1 : 0);
    if (scenario.create === 201) {
      assert.equal(created.body.feature.headline, CAMPAIGN_INPUT.headline);
      assert.equal(created.body.feature.destinationUrl, CAMPAIGN_INPUT.destinationUrl);
      assert.equal(created.body.feature.placementKey, 'HOMEPAGE_SPONSORED_FEATURE');
    }
    assert.deepEqual(state.rows.SponsoredFeature.slice(0, existing.length), existing);
    assert.deepEqual(state.rows.News, []);
    assert.deepEqual(state.rows.Article, []);
  });
}

test('Sponsored Admin read-only Ads Staff can inspect but cannot mutate campaigns', async context => {
  const state = installAdminAccess(context, { staff: { moduleAccessOverride: ['ads_manager'] } });
  const role = 'finance & accounts manager';
  for (const path of ADMIN_READS) {
    const response = await state.request('get', `/api/admin${path}`, undefined, role)
      .timeout({ response: 2000, deadline: 3000 });
    assert.equal(response.status, 200, response.text);
  }
  state.calls.length = 0;
  for (const [method, path] of ADMIN_WRITES) {
    const response = await state.request(method, `/api/admin${path}`, CAMPAIGN_INPUT, role)
      .timeout({ response: 2000, deadline: 3000 });
    assert.equal(response.status, 403, response.text);
  }
  assert.equal(state.calls.some(call => ['SponsoredFeature', 'Article', 'News'].includes(call.name)), false);
});

for (const [index, stage] of ['query construction', 'query execution', 'linked article enrichment'].entries()) {
  test(`Sponsored Admin list forwards ${stage} failures without leaking database details`, async context => {
    const { state } = install(context);
    const environment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    context.after(() => { process.env.NODE_ENV = environment; });
    const logged = context.mock.method(console, 'error', () => {});
    const error = new Error('PRIVATE_SPONSORED_QUERY_DETAIL');
    error.stack = 'PRIVATE_SPONSORED_QUERY_STACK';
    const status = index === 0 ? 500 : 503;
    if (status === 503) error.statusCode = status;
    let failures = 0;
    const reject = () => { failures += 1; throw error; };
    if (stage === 'query construction') context.mock.method(SponsoredFeature, 'find', reject);
    else if (stage === 'linked article enrichment') context.mock.method(Article, 'findOne', reject);
    else context.mock.method(SponsoredFeature, 'find', () => ({
      sort() { return this; }, lean: async () => reject(),
    }));
    const response = await state.request('get', `${ADMIN_PREFIXES[index]}/sponsored-features`, undefined, 'founder')
      .timeout({ response: 2000, deadline: 3000 });
    assert.equal(failures, 1);
    assert.equal(response.status, status, response.text);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.success, false);
    assert.equal(response.body.status, status);
    assert.equal(response.body.message, 'Internal server error');
    assert.equal(response.body.data, null);
    assert.equal(Object.hasOwn(response.body, 'stack'), false);
    assert.equal(Object.hasOwn(response.body, 'items'), false);
    assert.doesNotMatch(response.text, /PRIVATE_SPONSORED_QUERY/);
    assert.equal(logged.mock.callCount(), 1);
  });
}

for (const mode of ['published editorial', 'withdrawn editorial', 'conflicting editorial', 'paid placement']) {
  test(`homepage center preserves existing ${mode} selection behavior`, async context => {
    const { state, copy } = install(context, {
      prepare(state, source, copy) {
        if (mode === 'paid placement') return;
        for (const doc of [source, copy]) Object.assign(doc, {
          isSponsored: false, isSponsoredArticle: false, sponsorFeatureLinkedId: null,
        });
        if (mode === 'withdrawn editorial') source.status = 'deleted';
        if (mode === 'conflicting editorial') CONFLICTS[0].prepare(state, source, copy);
      },
    });
    const response = await state.get('/api/public/homepage/center-slot');
    assert.equal(response.status, 200, response.text);
    if (mode === 'published editorial') {
      assert.equal(response.body.selectedSource, 'spotlight');
      assert.equal(response.body.items[0].article.slug, copy.slug);
      assert.equal(response.body.items[0].headline, copy.title);
    } else {
      assert.equal(response.body.selectedSource, 'safe-default');
      assert.deepEqual(response.body.items, []);
      assert.ok(!response.text.includes(copy.slug));
    }
    assert.equal(state.calls.filter(call => call.name === 'SponsoredFeature').length, 0);
  });
}
