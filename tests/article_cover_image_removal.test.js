const isolation = require('./helpers/adminPutIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');

const LANGUAGES = ['en', 'hi', 'gu'];
const EDITOR = {
  specialRightsConfigured: true, specialRightsOverride: ['news_edit'],
  moduleAccessStates: { manageNews: 'enabled' },
};
const PRESERVED = [
  '_id', 'status', 'slug', 'slugs', 'publishedAt', 'sourceNewsId', 'sourceArticleId', 'sourceLanguage',
  'language', 'lang', 'originalLang', 'translationKey', 'translationGroupId',
];
const snapshot = state => structuredClone({ News: state.rows.News, Article: state.rows.Article });

function install(context, staff = EDITOR) {
  const state = installEditorialFixture(context, {
    staff, modulePolicies: { manageNews: 'available', addNews: 'available', draftDesk: 'available' },
  });
  seedGroup(state);
  for (const doc of state.rows.News) {
    doc.category = 'business';
    doc.tags = [];
    doc.publishedAt = new Date('2020-06-01T08:00:00.000Z');
    doc.humanEdited = true;
  }
  for (const copy of state.rows.Article) {
    copy.category = 'business';
    copy.tags = [];
    copy.slug = `original-public-${copy.language}`;
    copy.slugs = Object.fromEntries(LANGUAGES.map(lang => [lang, `original-public-${lang}`]));
    copy.publishedAt = new Date(`2019-0${LANGUAGES.indexOf(copy.language) + 1}-01T08:00:00.000Z`);
  }
  return state;
}

function assertPreserved(state, before, editedId) {
  for (const name of ['News', 'Article']) {
    assert.deepEqual(state.rows[name].map(doc => doc._id), before[name].map(doc => doc._id), `${name} record IDs`);
    for (const previous of before[name]) {
      const current = state.rows[name].find(doc => doc._id === previous._id);
      for (const field of PRESERVED) {
        assert.deepEqual(current[field] ?? null, previous[field] ?? null, `${name}.${field}`);
      }
      if ((current.sourceNewsId || current._id) !== editedId) {
        for (const field of ['title', 'content']) assert.equal(current[field], previous[field], `other edition ${name}.${field}`);
      }
    }
  }
  assert.equal(state.calls.filter(call => call.name === 'News' && (call.method === 'create' || call.options?.upsert)).length, 0);
  assert.equal(state.calls.filter(call => call.name === 'Article' && call.options?.upsert).length, 0);
}

const OLD_COVER = 'https://images.example/original-cover.jpg';
const NEW_COVER = 'https://images.example/replacement-cover.jpg';
const LEGACY_IMAGE_FIELDS = ['imageUrl', 'image', 'thumbnail', 'images', 'imageAlt', 'imageCaption'];

function installCoverFixture(context, staff = EDITOR) {
  const state = install(context, staff);
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    doc.coverImage = { url: OLD_COVER, publicId: 'original-cover', alt: 'Original cover' };
    doc.coverImageUrl = OLD_COVER;
    doc.imageURL = OLD_COVER;
    doc.imageUrl = OLD_COVER;
    doc.image = { url: OLD_COVER };
    doc.thumbnail = OLD_COVER;
    doc.images = [OLD_COVER];
    doc.imageAlt = 'Original cover';
    doc.imageCaption = 'Original caption';
    doc.content += `<img src="${OLD_COVER}" alt="Body image">`;
    doc.gallery = ['https://images.example/gallery.jpg'];
  }
  return state;
}

function assertCoverState(state, before, expectedUrl) {
  assertPreserved(state, before);
  for (const name of ['News', 'Article']) for (const doc of state.rows[name]) {
    const previous = before[name].find(row => row._id === doc._id);
    assert.equal(doc.coverImage.url, expectedUrl, `${name} ${doc.language} stored cover`);
    assert.deepEqual(doc.gallery, previous.gallery, 'cover edits do not remove gallery images');
    if (expectedUrl === null) {
      assert.deepEqual(doc.coverImage, { url: null, publicId: null, alt: null, removed: true });
      for (const field of ['coverImageUrl', 'imageURL', ...LEGACY_IMAGE_FIELDS]) {
        assert.equal(doc[field] ?? null, null, `${name}.${field} cannot restore the removed cover`);
      }
    }
  }
}

async function assertCoverReads(state, before, expectedUrl) {
  for (const source of before.News.length ? before.News : before.Article) {
    const copy = before.Article.find(row => row.sourceNewsId === source._id) || source;
    const admin = await state.request('get', `/api/articles/${source._id}`);
    assert.equal(admin.status, 200, admin.text);
    assert.equal(admin.body.article.coverImage.url, expectedUrl, 'admin reload');
    assert.equal(admin.body.article.coverImageUrl, expectedUrl, 'admin legacy cover URL');
    if (expectedUrl === null) assert.equal(admin.body.article.coverImage.removed, true);

    const detail = await state.request('get', `/api/public/news/slug/${copy.slug}?lang=${source.language}`, undefined, null);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.title, source.title);
    assert.equal(detail.body.content, source.content, 'inline body images remain intact');
    assert.equal(detail.body.slug, copy.slug);
    assert.equal(detail.body.publishedAt, copy.publishedAt.toISOString());
    if (before.News.length) assert.equal(detail.body.status, 'published');
    assert.equal(detail.body.imageUrl, expectedUrl, 'public detail image');
    assert.equal(detail.body.coverImageUrl, expectedUrl, 'public detail legacy cover URL');

    if (!before.News.length) continue;
    const feed = await state.request('get', `/api/public/news?lang=${source.language}&limit=10`, undefined, null);
    assert.equal(feed.status, 200, feed.text);
    const item = feed.body.items.find(row => row.title === source.title);
    assert.ok(item, `${source.language} edition remains publicly listed`);
    assert.equal(item.imageUrl, expectedUrl, 'public listing image');
    assert.equal(item.coverImageUrl, expectedUrl, 'public listing legacy cover URL');
  }
}

for (const language of LANGUAGES) for (const action of ['keep', 'replace', 'remove']) {
  test(`published cover ${action} via ${language} PUT preserves editions, publication and reloads`, async context => {
    const state = installCoverFixture(context);
    const source = state.rows.News.find(doc => doc.language === language);
    const before = snapshot(state);
    const body = action === 'keep' ? { title: source.title, content: source.content }
      : action === 'remove' ? {
        removeCoverImage: true, coverImage: source.coverImage, coverImageUrl: OLD_COVER, imageURL: OLD_COVER,
      } : {
        coverImage: { url: NEW_COVER, publicId: 'replacement-cover', alt: 'Replacement cover' },
        coverImageUrl: OLD_COVER, imageURL: OLD_COVER,
      };
    const expectedUrl = action === 'keep' ? OLD_COVER : action === 'replace' ? NEW_COVER : null;
    const response = await state.request('put', `/api/articles/${source._id}`, body);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.article.coverImage.url, expectedUrl);
    assertCoverState(state, before, expectedUrl);
    await assertCoverReads(state, before, expectedUrl);

    const saveAgain = await state.request('put', `/api/articles/${source._id}`, {
      title: source.title, content: source.content, removeCoverImage: false,
    });
    assert.equal(saveAgain.status, 200, saveAgain.text);
    assertCoverState(state, before, expectedUrl);
    await assertCoverReads(state, before, expectedUrl);
    for (const copy of before.Article) assert.ok(state.invalidations.some(event => event.paths.includes(
      `${copy.language === 'en' ? '' : `/${copy.language}`}/news/${copy.slug}`
    )), 'invalidate the unchanged public URL');
  });
}

test('published cover null, blank and placeholder fields keep the existing image without the removal flag', async context => {
  const state = installCoverFixture(context);
  const before = snapshot(state);
  for (const body of [
    { coverImage: null },
    { coverImage: { url: null, publicId: null, alt: null } },
    { coverImage: { url: '  ', publicId: null, alt: null } },
    { coverImageUrl: null, imageURL: '' },
    { coverImageUrl: 'undefined', imageURL: 'null' },
    { removeCoverImage: false },
  ]) {
    const response = await state.request('put', `/api/articles/${before.News[0]._id}`, body);
    assert.equal(response.status, 200, response.text);
    assertCoverState(state, before, OLD_COVER);
    for (const name of ['News', 'Article']) for (const doc of state.rows[name]) {
      assert.deepEqual(doc.coverImage, before[name].find(row => row._id === doc._id).coverImage);
    }
  }
});

for (const field of ['coverImageUrl', 'imageURL']) {
  test(`published cover can be removed then replaced using legacy ${field} without resurrecting old URLs`, async context => {
    const state = installCoverFixture(context);
    const before = snapshot(state);
    const path = `/api/articles/${before.News[0]._id}`;
    const removed = await state.request('patch', path, { removeCoverImage: true });
    assert.equal(removed.status, 200, removed.text);
    assertCoverState(state, before, null);
    const replaced = await state.request('put', path, { [field]: NEW_COVER });
    assert.equal(replaced.status, 200, replaced.text);
    assertCoverState(state, before, NEW_COVER);
    for (const doc of [...state.rows.News, ...state.rows.Article]) {
      assert.notEqual(doc.coverImage.removed, true);
    }
    await assertCoverReads(state, before, NEW_COVER);
  });
}

test('published cover removal retains an independently customized edition image', async context => {
  const state = installCoverFixture(context);
  const distinct = 'https://images.example/gujarati-cover.jpg';
  for (const doc of [...state.rows.News, ...state.rows.Article].filter(row => row.language === 'gu')) {
    doc.coverImage = { url: distinct, publicId: 'gujarati-cover', alt: 'Gujarati cover' };
    doc.coverImageUrl = distinct;
    doc.imageURL = distinct;
    for (const field of LEGACY_IMAGE_FIELDS) delete doc[field];
  }
  const before = snapshot(state);
  const response = await state.request('put', `/api/articles/${before.News[0]._id}`, { removeCoverImage: true });
  assert.equal(response.status, 200, response.text);
  assertPreserved(state, before);
  for (const name of ['News', 'Article']) for (const doc of state.rows[name]) {
    assert.equal(doc.coverImage.url, doc.language === 'gu' ? distinct : null);
  }
  const copy = before.Article.find(row => row.language === 'gu');
  const detail = await state.request('get', `/api/public/news/slug/${copy.slug}?lang=gu`, undefined, null);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.imageUrl, distinct);
});

test('published cover public-only compatibility saves support keep, remove and replace', async context => {
  const state = installCoverFixture(context);
  state.rows.News = [];
  state.rows.Article = [state.rows.Article[0]];
  const copy = state.rows.Article[0];
  for (const field of ['sourceArticleId', 'sourceNewsId', 'translationGroupId', 'translationKey']) delete copy[field];
  const before = snapshot(state);
  for (const [body, expectedUrl] of [
    [{ coverImage: null }, OLD_COVER],
    [{ removeCoverImage: true }, null],
    [{ coverImage: { url: NEW_COVER } }, NEW_COVER],
  ]) {
    const response = await state.request('put', `/api/articles/${copy._id}`, body);
    assert.equal(response.status, 200, response.text);
    assertCoverState(state, before, expectedUrl);
    await assertCoverReads(state, before, expectedUrl);
  }
});

test('published cover removal rolls back when public synchronization fails', async context => {
  const state = installCoverFixture(context);
  const before = snapshot(state);
  state.failures['Article.findOneAndUpdate'] = { once: true };
  const response = await state.request('put', `/api/articles/${before.News[0]._id}`, { removeCoverImage: true });
  assert.equal(response.status, 503, response.text);
  assert.deepEqual(snapshot(state), before);
  assert.equal(state.invalidations.length, 0);
});

for (const denied of ['unauthenticated', 'missing edit right', 'disabled module']) {
  test(`published cover removal does not grant access to ${denied} users`, async context => {
    const state = installCoverFixture(context, {
      ...EDITOR,
      ...(denied === 'missing edit right' ? { specialRightsOverride: [] } : {}),
      ...(denied === 'disabled module' ? { moduleAccessStates: { manageNews: 'disabled' } } : {}),
    });
    const before = snapshot(state);
    const response = await state.request('put', `/api/articles/${before.News[0]._id}`, { removeCoverImage: true },
      denied === 'unauthenticated' ? null : 'editor');
    assert.equal(response.status, denied === 'unauthenticated' ? 401 : 403, response.text);
    assert.deepEqual(snapshot(state), before);
    assert.equal(state.invalidations.length, 0);
  });
}

test('published cover changes retain the existing authorized Editor save scope', async context => {
  const state = installCoverFixture(context);
  const before = snapshot(state);
  const response = await state.request('put', `/api/articles/${before.News[0]._id}`, { removeCoverImage: true }, 'editor');
  assert.equal(response.status, 200, response.text);
  assertCoverState(state, before, null);
});

test('published cover removal flag rejects non-boolean values without writes', async context => {
  const state = installCoverFixture(context);
  const before = snapshot(state);
  const response = await state.request('put', `/api/articles/${before.News[0]._id}`, { removeCoverImage: 'true' });
  assert.equal(response.status, 400, response.text);
  assert.deepEqual(snapshot(state), before);
  assert.equal(state.invalidations.length, 0);
});

test('published cover absence still permits the existing inline-image fallback when not explicitly removed', async context => {
  const state = installCoverFixture(context);
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    for (const field of ['coverImage', 'coverImageUrl', 'imageURL', ...LEGACY_IMAGE_FIELDS]) delete doc[field];
  }
  const copy = state.rows.Article[0];
  const detail = await state.request('get', `/api/public/news/slug/${copy.slug}?lang=en`, undefined, null);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.imageUrl, OLD_COVER);
});

test('published cover metadata-only saves retain legacy-only image URLs without a removal flag', async context => {
  const state = installCoverFixture(context);
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    for (const field of ['coverImage', 'coverImageUrl', 'imageURL']) delete doc[field];
  }
  const before = snapshot(state);
  const response = await state.request('put', `/api/articles/${before.News[0]._id}`, {
    coverImage: { publicId: null, alt: null },
  });
  assert.equal(response.status, 200, response.text);
  assertPreserved(state, before);
  for (const doc of [...state.rows.News, ...state.rows.Article]) assert.equal(doc.imageUrl, OLD_COVER);
  const detail = await state.request('get', `/api/public/news/slug/${before.Article[0].slug}?lang=en`, undefined, null);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body.imageUrl, OLD_COVER);
});

test('published cover removal survives Mongoose casting and model serialization without legacy URLs', async context => {
  const {
    buildCoverImagePatch, COVER_IMAGE_FALLBACK_UNSET, PUBLIC_COVER_IMAGE_FALLBACK_UNSET,
  } = require('../services/articleCoverImage.service');
  for (const name of ['News', 'Article']) {
    const Model = require(`../models/${name}`);
    const previous = {
      _id: '507f1f77bcf86cd79943a001', title: 'Schema cover', description: 'Summary', summary: 'Summary',
      content: '<p>Body</p>', slug: 'schema-cover', category: 'business', language: 'en', status: 'published',
      coverImage: { url: OLD_COVER, publicId: 'original-cover', alt: 'Original cover' },
      coverImageUrl: OLD_COVER, imageURL: OLD_COVER, imageUrl: OLD_COVER, thumbnail: OLD_COVER,
    };
    const patch = buildCoverImagePatch({ removeCoverImage: true }, previous);
    context.mock.method(Model.collection, 'findOneAndUpdate', async (_filter, operation) => {
      const stored = { ...previous, ...operation.$set };
      for (const field of Object.keys(operation.$unset || {})) delete stored[field];
      return { value: stored };
    });
    const saved = await Model.findOneAndUpdate({ _id: previous._id }, {
      $set: name === 'News' ? patch : { coverImage: patch.coverImage },
      $unset: name === 'News' ? { ...COVER_IMAGE_FALLBACK_UNSET } : { ...PUBLIC_COVER_IMAGE_FALLBACK_UNSET },
    }, { new: true, runValidators: true, strict: false });
    for (const serialized of [saved.toObject(), saved.toJSON()]) {
      assert.deepEqual(serialized.coverImage, { url: null, publicId: null, alt: null, removed: true });
      for (const field of ['imageUrl', 'thumbnail', 'coverImageUrl', 'imageURL']) {
        assert.equal(serialized[field] ?? null, null, `${name}.${field} after persistence casting`);
      }
      assert.equal(serialized.title, previous.title);
      assert.equal(serialized.content, previous.content);
      assert.equal(serialized.status, 'published');
    }
  }
});

test.after(() => isolation.assertNoSideEffects());
