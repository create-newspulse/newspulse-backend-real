const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { installEditorialFixture, seedGroup, matches, models } = require('./helpers/editorialLifecycleFixture');
const { getPublicTopic, listTopicStories } = require('../services/editorialTopics.service');
const { onArticleCachesInvalidated } = require('../lib/cache');
const { publishDueScheduledArticles, refreshDuePublicArticleVisibility } = require('../services/scheduledPublication.service');

const date = value => value == null ? null : new Date(value).toISOString();

for (const [index, language] of ['en', 'hi', 'gu'].entries()) {
  for (const method of ['put', 'patch']) {
    test(`${method.toUpperCase()} status-only Publish via ${language} ignores client publishedAt and publishes all eligible editions`, async context => {
      const state = installEditorialFixture(context);
      const { ids } = seedGroup(state, { status: 'draft', copies: false });
      const started = Date.now();
      const response = await state.request(method, `/admin-api/articles/${ids[index]}`, {
        status: 'published', publishedAt: '1999-01-01T00:00:00.000Z',
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual([...response.body.publishedLanguages].sort(), ['en', 'gu', 'hi']);
      assert.equal(state.rows.News.length, 3);
      assert.equal(state.rows.Article.length, 3);
      for (const doc of [...state.rows.News, ...state.rows.Article]) {
        assert.equal(doc.status, 'published');
        assert.ok(new Date(doc.publishedAt).getTime() >= started);
        assert.ok(new Date(doc.publishedAt).getTime() <= Date.now());
      }
      assert.equal(new Set(state.rows.News.map(doc => date(doc.publishedAt))).size, 1);
      assert.equal(state.rows.TranslationJob.length, 0);
      assert.equal(state.invalidations.length, 1);
    });
  }

  test(`Unpublish via ${language} retains chronology and removes all editions and compatibility copies`, async context => {
    const state = installEditorialFixture(context);
    const { ids, publication } = seedGroup(state);
    const invalidated = [];
    context.after(onArticleCachesInvalidated(event => invalidated.push(event)));
    const response = await state.request('post', `/api/articles/${ids[index]}/unpublish`, {});
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.changedCount, 3);
    for (const doc of [...state.rows.News, ...state.rows.Article]) {
      assert.equal(doc.status, 'draft');
      assert.equal(date(doc.publishedAt), date(publication));
    }
    assert.ok(invalidated.some(event => event.publicVisibilityRemoved));
    assert.equal((await getPublicTopic('navratri-2026', { lang: language })).pinnedArticle, null);
    assert.equal((await listTopicStories('navratri-2026', { lang: language })).total, 0);
  });

  test(`Soft delete and Founder restore via ${language} operate on the complete story without duplicates`, async context => {
    const state = installEditorialFixture(context);
    const { ids, publication } = seedGroup(state);
    const originalCopyIds = state.rows.Article.map(doc => doc._id);
    const deleted = await state.request('delete', `/api/articles/${ids[index]}`);
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.body.deletedCount, 3);
    for (const doc of state.rows.News) {
      assert.equal(doc.status, 'deleted');
      assert.equal(doc.deletedFromStatus, 'published');
      assert.ok(doc.deletedAt);
      assert.equal(date(doc.publishedAt), date(publication));
    }
    assert.ok(state.rows.Article.every(doc => doc.status === 'deleted'));
    assert.equal((await getPublicTopic('navratri-2026', { lang: language })).pinnedArticle, null);
    const restored = await state.request('post', `/api/admin/drafts/${ids[index]}/restore`, {});
    assert.equal(restored.statusCode, 200);
    assert.deepEqual(restored.body.restoredStatuses, ['published']);
    assert.equal(state.rows.News.length, 3);
    assert.deepEqual(state.rows.Article.map(doc => doc._id), originalCopyIds);
    for (const doc of [...state.rows.News, ...state.rows.Article]) {
      assert.equal(doc.status, 'published');
      assert.equal(doc.deletedAt, null);
      assert.equal(date(doc.publishedAt), date(publication));
    }
    assert.ok((await getPublicTopic('navratri-2026', { lang: language })).pinnedArticle);
  });
}

test('legacy same-story shared slugs publish, unpublish and edit without false 409 or duplicate public copies', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'draft', sharedSlug: true });
  let response = await state.request('patch', `/admin-api/articles/${ids[0]}`, { status: 'published' });
  assert.equal(response.statusCode, 200);
  assert.equal(state.rows.Article.length, 1);
  for (const language of ['en', 'hi', 'gu']) assert.equal(state.rows.Article[0].translationStatus[language], 'ready');
  response = await state.request('put', `/admin-api/articles/${ids[0]}`, { slug: 'shared-story', title: 'Updated headline' });
  assert.equal(response.statusCode, 200);
  assert.equal(state.rows.Article.length, 1);
  assert.equal(state.rows.Article[0].translations.en.title, 'Updated headline');
  response = await state.request('patch', `/admin-api/articles/${ids[1]}`, { status: 'draft', publishedAt: new Date().toISOString() });
  assert.equal(response.statusCode, 200);
  assert.ok(state.rows.News.every(doc => doc.status === 'draft'));
  assert.ok(state.rows.Article.every(doc => doc.status === 'draft'));
});

for (const field of ['slug', 'slugs.en', 'slugs.hi', 'slugs.gu']) {
  test(`unrelated duplicate in ${field} still returns 409 before an edit is persisted`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state);
    const other = { _id: '507f1f77bcf86cd79943b999', slug: 'other-story', translationGroupId: 'other', status: 'draft' };
    if (field === 'slug') other.slug = 'occupied';
    else other.slugs = { [field.slice(6)]: 'occupied' };
    state.rows.News.push(other);
    const response = await state.request('put', `/api/articles/${ids[0]}`, { slug: 'occupied' });
    assert.equal(response.statusCode, 409);
    assert.equal(state.rows.News[0].slug, 'story-en');
  });
}

test('slug validation retains logical-story identity for real Mongoose documents', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'draft', sharedSlug: true });
  const News = require('../models/News');
  const { assertSlugUnique } = require('../services/articleSlugUniqueness.service');
  const doc = new News(state.rows.News[0]);
  await assertSlugUnique(doc.slug, doc._id, doc);
  state.rows.News.push({ _id: '507f1f77bcf86cd79943b999', slug: 'shared-story', status: 'draft' });
  await assert.rejects(assertSlugUnique(doc.slug, ids[0], doc), { code: 'SLUG_CONFLICT', statusCode: 409 });
});

test('publication commits News and compatibility copies atomically', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'draft', copies: false });
  const syncCopy = models.Article.findOneAndUpdate;
  let writes = 0;
  context.mock.method(models.Article, 'findOneAndUpdate', (...args) => {
    if (++writes === 2) throw new Error('Synthetic second-copy failure');
    return syncCopy(...args);
  });
  const response = await state.request('post', `/api/articles/${ids[0]}/publish`, {});
  assert.equal(response.status, 503);
  assert.ok(state.rows.News.every(doc => doc.status === 'draft' && doc.publishedAt === null));
  assert.equal(state.rows.Article.length, 0);
  assert.equal(state.rows.PushHistory.length, 0);
  assert.ok(state.transactions.at(-1).aborted && state.transactions.at(-1).ended);
});

for (const deletion of ['soft', 'permanent']) {
  test(`an in-flight publication cannot revive a ${deletion}-deleted story`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: 'draft' });
    const startSession = mongoose.startSession;
    context.mock.method(mongoose, 'startSession', async () => {
      if (deletion === 'permanent') {
        state.rows.News = [];
        state.rows.Article = [];
      } else {
        for (const doc of [...state.rows.News, ...state.rows.Article]) {
          doc.status = 'deleted';
          doc.deletedAt = new Date();
        }
      }
      return startSession();
    });
    const response = await state.request('post', `/api/articles/${ids[0]}/publish`, {});
    assert.equal(response.status, 409);
    assert.equal(state.rows.News.length, deletion === 'permanent' ? 0 : 3);
    assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === 'deleted'));
  });
}

test('publishing source-linked legacy editions does not generate duplicate translations', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'draft' });
  for (const doc of state.rows.News.slice(1)) {
    delete doc.translationGroupId;
    delete doc.translationKey;
  }
  const response = await state.request('post', `/api/articles/${ids[0]}/publish`, {});
  assert.equal(response.status, 200);
  assert.deepEqual(state.rows.News.map(doc => doc._id), ids);
  assert.ok(state.rows.News.every(doc => doc.status === 'published'));
  assert.equal(state.rows.TranslationJob.length, 0);
  assert.ok(state.invalidations.every(payload => !payload.q));
});

test('publication keeps stale legacy duplicate copies hidden and preserves their chronology', async context => {
  const state = installEditorialFixture(context);
  const { ids, publication } = seedGroup(state);
  const staleId = '607f1f77bcf86cd79943b999';
  state.rows.Article.push({
    _id: staleId, slug: 'obsolete-public-copy', translationGroupId: 'story-test-group',
    status: 'published', publishedAt: publication, language: 'en',
  });
  const response = await state.request('post', `/api/articles/${ids[0]}/publish`, {});
  assert.equal(response.status, 200);
  assert.equal(state.rows.Article.filter(doc => doc.status === 'published').length, 3);
  const stale = state.rows.Article.find(doc => doc._id === staleId);
  assert.equal(stale.status, 'draft');
  assert.equal(date(stale.publishedAt), date(publication));
});

test('lifecycle state and history validate against the real News schema', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  await state.request('delete', `/api/articles/${ids[0]}`);
  for (const record of state.rows.News) await new models.News(record).validate();
  await state.request('post', `/api/articles/${ids[0]}/restore`, {});
  for (const record of state.rows.News) await new models.News(record).validate();
  for (const record of state.rows.Article) await new models.Article(record).validate();
});

for (const method of ['put', 'patch']) {
  for (const edit of [false, true]) {
    test(`${method.toUpperCase()} withdrawal through an already-draft edition remains group-wide with edit=${edit}`, async context => {
      const state = installEditorialFixture(context);
      const { ids, publication } = seedGroup(state);
      state.rows.News[1].status = 'draft';
      const body = { status: 'draft', ...(edit ? { title: 'Edited native draft' } : {}) };
      const denied = await state.request(method, `/api/articles/${ids[1]}`, body, 'editor');
      assert.equal(denied.status, 403);
      assert.equal(state.rows.News[1].title, 'hi headline');
      const response = await state.request(method, `/api/articles/${ids[1]}`, body);
      assert.equal(response.status, 200);
      for (const doc of [...state.rows.News, ...state.rows.Article]) {
        assert.equal(doc.status, 'draft');
        assert.equal(date(doc.publishedAt), date(publication));
      }
    });
  }
}

test('status-only Publish on an already-published edition publishes its eligible draft sibling', async context => {
  const state = installEditorialFixture(context);
  const { ids, publication } = seedGroup(state);
  state.rows.News[1].status = 'draft';
  const response = await state.request('patch', `/api/articles/${ids[0]}`, { status: 'published' });
  assert.equal(response.status, 200);
  assert.ok(state.rows.News.every(doc => doc.status === 'published' && date(doc.publishedAt) === date(publication)));
  assert.equal(state.rows.News.length, 3);
});

test('scheduling refuses deleted stories and rolls back a failed group visibility update', async context => {
  const state = installEditorialFixture(context);
  const { ids, publication } = seedGroup(state);
  const body = { scheduledAt: '2099-01-01T00:00:00.000Z' };
  state.failures['Article.updateMany'] = { once: true };
  let response = await state.request('post', `/api/articles/${ids[0]}/schedule`, body);
  assert.equal(response.status, 503);
  assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === 'published'));
  assert.ok(state.rows.News.every(doc => date(doc.publishedAt) === date(publication)));
  await state.request('delete', `/api/articles/${ids[0]}`);
  const deleted = structuredClone(state.rows.News);
  response = await state.request('post', `/api/articles/${ids[0]}/schedule`, body);
  assert.equal(response.status, 409);
  assert.deepEqual(state.rows.News, deleted);
});

test('a failed published image edit rolls back and retries without losing shared or custom images', async context => {
  const state = installEditorialFixture(context);
  const { ids, publication } = seedGroup(state);
  state.rows.News[2].coverImage = { url: '/uploads/custom-gu.jpg', alt: 'Custom' };
  const body = { coverImage: { url: '/uploads/revised-shared.jpg', alt: 'Revised' } };
  state.failures['Article.findOneAndUpdate'] = { once: true };
  let response = await state.request('put', `/api/articles/${ids[0]}`, body);
  assert.equal(response.status, 503);
  assert.equal(state.rows.News[0].coverImage.url, '/uploads/shared.jpg');
  assert.equal(state.rows.News[1].coverImage.url, '/uploads/shared.jpg');
  response = await state.request('put', `/api/articles/${ids[0]}`, body);
  assert.equal(response.status, 200);
  assert.equal(state.rows.News[0].coverImage.url, body.coverImage.url);
  assert.equal(state.rows.News[1].coverImage.url, body.coverImage.url);
  assert.equal(state.rows.News[2].coverImage.url, '/uploads/custom-gu.jpg');
  assert.ok(state.rows.News.every(doc => date(doc.publishedAt) === date(publication)));
});

for (const owner of ['sourceNewsId', 'sourceArticleId', 'translationGroupId', 'translationKey']) {
  test(`a foreign copy identified by ${owner} is neither overwritten nor permanently deleted`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: 'draft', copies: false });
    const foreign = {
      _id: '607f1f77bcf86cd79943b999', slug: 'story-en', status: 'published',
      [owner]: owner.endsWith('Id') && owner !== 'translationGroupId' ? '507f1f77bcf86cd79943b999' : 'foreign-story',
    };
    state.rows.Article.push(foreign);
    const response = await state.request('post', `/api/articles/${ids[0]}/publish`, {});
    assert.equal(response.status, 409);
    assert.deepEqual(state.rows.Article, [foreign]);
    assert.equal((await state.request('delete', `/api/articles/${ids[0]}`)).status, 200);
    assert.equal((await state.request('delete', `/api/articles/${ids[0]}/permanent`)).status, 200);
    assert.deepEqual(state.rows.Article, [foreign]);
  });
}

test('legacy sourceArticleId links cannot bypass a hidden News source', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'draft' });
  const copy = state.rows.Article[0];
  copy.status = 'published';
  copy.sourceNewsId = null;
  copy.sourceArticleId = ids[0];
  for (const path of [`/api/public/news/${copy._id}`, `/api/articles/${copy._id}`]) {
    assert.equal((await state.request('get', path, undefined, null)).status, 404);
  }
});

for (const [name, expected] of [['MongoNetworkError', 503], ['Error', 500]]) {
  test(`public article and translation reads surface ${name} without fabricated data`, async context => {
    const state = installEditorialFixture(context);
    seedGroup(state);
    state.failures['News.findOne'] = { name };
    state.failures['News.find'] = { name };
    for (const path of [
      '/api/public/news/story-en?lang=en',
      '/api/public/news/slug/story-en?lang=en',
      '/api/public/news/translation?translationKey=story-test-group&lang=en',
      '/api/public/news/translations/story-test-group',
    ]) {
      const response = await state.request('get', path, undefined, null);
      assert.equal(response.status, expected);
      assert.equal(response.body.ok, false);
      assert.equal(Object.hasOwn(response.body, 'items'), false);
      assert.equal(Object.hasOwn(response.body, 'total'), false);
      assert.equal(JSON.stringify(response.body).includes('Synthetic storage failure'), false);
    }
  });
}

test('ordinary Pulse Dialogue edits do not propagate dedicated metadata to other editions', async context => {
  const Contributor = require('../models/Contributor');
  const { getPulseDialogueStandardText } = require('../services/pulseDialogue.service');
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  const contributor = { _id: '507f1f77bcf86cd79943c999', status: 'active', canonicalName: 'Test contributor' };
  context.mock.method(Contributor, 'findById', () => ({ lean: async () => contributor }));
  for (const doc of state.rows.News) {
    doc.category = 'pulse-dialogue';
    doc.pulseDialogue = {
      contributorId: contributor._id, dialogueFormat: 'essay', series: 'Original', editorNote: 'Original note',
      ...getPulseDialogueStandardText(doc.language),
    };
  }
  const response = await state.request('put', `/api/articles/${ids[0]}`, {
    pulseDialogue: { ...state.rows.News[0].pulseDialogue, series: 'Updated series', editorNote: 'Updated note' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    const standard = getPulseDialogueStandardText(doc.language);
    const edited = String(doc.sourceNewsId || doc._id) === ids[0];
    assert.equal(doc.pulseDialogue.series, edited ? 'Updated series' : 'Original');
    assert.equal(doc.pulseDialogue.editorNote, edited ? 'Updated note' : 'Original note');
    assert.equal(doc.pulseDialogue.contributorDisclosure, standard.contributorDisclosure);
    assert.equal(doc.pulseDialogue.contributorDisclaimer, standard.contributorDisclaimer);
    assert.equal(doc.title, `${doc.language} headline`);
  }
});

for (const [label, gates] of [
  ['private', { isPrivate: true }],
  ['locked', { locked: true }],
  ['embargoed', { embargoUntil: new Date('2099-01-01T00:00:00.000Z') }],
  ['workflow locked', { workflow: { locked: true } }],
  ['future scheduled', { scheduledAt: new Date('2099-01-01T00:00:00.000Z') }],
]) {
  test(`a ${label} native edition cannot escape through cached translations or a shared public slug`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { sharedSlug: true });
    Object.assign(state.rows.News[2], gates);
    const response = await state.request('put', `/api/articles/${ids[0]}`, { title: 'Revised public English title' });
    assert.equal(response.status, 200);
    for (const doc of [...state.rows.News, ...state.rows.Article]) {
      assert.equal(doc.translationStatus.gu, 'pending');
      assert.ok(!doc.translations.gu?.content);
    }
    assert.equal(state.rows.Article.length, 1);
    assert.notEqual(state.rows.Article[0].sourceNewsId, ids[2]);
    assert.equal(state.rows.Article[0].locked, false);
    const gu = await state.request('get', '/api/public/news?category=faith-culture&lang=gu&strictLocale=true', undefined, null);
    assert.equal(gu.status, 200);
    assert.equal(gu.body.total, 0);
  });
}

for (const previouslyPublished of [false, true]) {
  test(`scheduled embargo expiry publishes all locales without ${previouslyPublished ? 'resetting' : 'backdating'} chronology`, async context => {
    context.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
    const state = installEditorialFixture(context);
    const { publication } = seedGroup(state, { status: 'scheduled', sharedSlug: true });
    const deadline = new Date(Date.now() + 1000);
    const copyIds = state.rows.Article.map(doc => doc._id);
    for (const doc of [...state.rows.News, ...state.rows.Article]) {
      doc.embargoUntil = deadline;
      doc.scheduledAt = new Date(Date.now() - 1000);
      doc.publishAt = doc.scheduledAt;
      doc.publishedAt = previouslyPublished ? publication : null;
    }
    context.mock.timers.tick(999);
    assert.equal((await publishDueScheduledArticles()).published, 0);
    assert.ok(state.rows.News.every(doc => doc.status === 'scheduled'));
    context.mock.timers.tick(1);
    assert.deepEqual(await publishDueScheduledArticles(), { processed: 3, published: 1, failed: 0, skipped: 2 });
    assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 0);
    assert.deepEqual(state.rows.Article.map(doc => doc._id), copyIds);
    assert.equal(state.rows.TranslationJob.length, 0);
    for (const doc of [...state.rows.News, ...state.rows.Article]) {
      assert.equal(date(doc.publishedAt), date(previouslyPublished ? publication : deadline));
      assert.equal(doc.status, 'published');
    }
    for (const lang of ['gu', 'hi', 'en']) {
      const response = await state.request('get', `/api/public/stories/shared-story?lang=${lang}`, undefined, null);
      assert.equal(response.status, 200);
      assert.equal(response.body.resolvedLang, lang);
      assert.equal(response.body.data.title, `${lang} headline`);
    }
  });
}

for (const field of ['embargoUntil', 'workflow.embargoUntil', 'publishedAt', 'publishAt', 'scheduledAt']) {
  for (const sharedSlug of [false, true]) {
    test(`clock expiry refreshes ${field} across native and ${sharedSlug ? 'shared-slug' : 'separate'} compatibility routes`, async context => {
      context.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
      const state = installEditorialFixture(context);
      const { ids } = seedGroup(state, { sharedSlug });
      const deadline = new Date(Date.now() + 1000);
      if (field.startsWith('workflow.')) state.rows.News[2].workflow = { embargoUntil: deadline };
      else state.rows.News[2][field] = deadline;
      const publicationDates = state.rows.News.map(doc => date(doc.publishedAt));
      const copyIds = state.rows.Article.map(doc => doc._id).sort();
      assert.equal((await state.request('put', `/api/articles/${ids[0]}`, { title: 'Updated before expiry' })).status, 200);
      assert.ok(state.rows.News.every(doc => date(doc.publicVisibilityRefreshAt) === date(deadline)));
      assert.ok(state.rows.Article.every(doc => doc.translationStatus.gu === 'pending'));

      const slug = sharedSlug ? 'shared-story' : 'story-gu';
      const before = await state.request('get', `/api/public/stories/${slug}?lang=gu`, undefined, null);
      assert.equal(before.status, 404);
      context.mock.timers.tick(999);
      assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 0);
      context.mock.timers.tick(1);
      const result = await refreshDuePublicArticleVisibility();
      assert.deepEqual(result, { processed: 3, refreshed: 1, failed: 0, skipped: 2 });
      assert.ok(state.rows.News.every(doc => doc.publicVisibilityRefreshAt === null));
      assert.deepEqual(state.rows.News.map(doc => date(doc.publishedAt)), publicationDates);
      assert.deepEqual(state.rows.Article.map(doc => doc._id).sort(), copyIds);
      assert.equal(state.rows.TranslationJob.length, 0);
      assert.equal(state.invalidations.at(-1).reason, 'article_visibility_refresh');
      assert.ok(state.invalidations.at(-1).paths.includes('/gu/topic/navratri-2026'));

      for (const path of [
        `/api/public/news/${slug}?lang=gu`, `/api/public/stories/${slug}?lang=gu`,
        `/api/articles/${copyIds[0]}?lang=gu`, `/api/articles/by-slug/${slug}?lang=gu`,
      ]) {
        const response = await state.request('get', path, undefined, null);
        assert.equal(response.status, 200, path);
        const doc = response.body.article || response.body.data?.article || response.body.data || response.body;
        assert.equal(response.body.resolvedLang || doc.resolvedLang || doc.language, 'gu', path);
        assert.equal(doc.title, 'gu headline', path);
      }
      for (const path of [
        '/api/public/news?category=faith-culture&lang=gu&strictLocale=true',
        '/api/public/stories?category=faith-culture&lang=gu',
        '/api/public/stories?lang=gu',
      ]) {
        const response = await state.request('get', path, undefined, null);
        assert.equal(response.status, 200, path);
        const items = response.body.items || response.body.data;
        assert.ok(items.length > 0, path);
        assert.ok(items.every(doc => doc.title === 'gu headline'), path);
      }
      const calls = state.invalidations.length;
      assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 0);
      assert.equal(state.invalidations.length, calls);
    });
  }
}

for (const sharedSlug of [false, true]) {
  test(`legacy ${sharedSlug ? 'shared-slug' : 'separate-copy'} embargo expiry refreshes automatically without a prior edit or migration`, async context => {
    context.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
    const state = installEditorialFixture(context);
    const { publication } = seedGroup(state, { sharedSlug });
    const copyIds = state.rows.Article.map(doc => doc._id).sort();
    state.rows.News[2].embargoUntil = new Date(Date.now() + 1000);
    context.mock.timers.tick(999);
    assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 0);
    context.mock.timers.tick(1);
    assert.deepEqual(await refreshDuePublicArticleVisibility(), { processed: 1, refreshed: 1, failed: 0, skipped: 0 });
    assert.ok(state.rows.News.every(doc => doc.publicVisibilityRefreshAt === null));
    assert.ok(state.rows.News.every(doc => date(doc.publishedAt) === date(publication)));
    assert.deepEqual(state.rows.Article.map(doc => doc._id).sort(), copyIds);
    const slug = sharedSlug ? 'shared-story' : 'story-gu';
    const response = await state.request('get', `/api/public/stories/${slug}?lang=gu`, undefined, null);
    assert.equal(response.status, 200);
    assert.equal(response.body.resolvedLang, 'gu');
    assert.equal(response.body.data.title, 'gu headline');
    assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 0);
    assert.equal(state.invalidations.length, 1);
  });
}

test('the existing embargo endpoint hides cached native text and queues automatic expiry', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
  const state = installEditorialFixture(context);
  const { ids, publication } = seedGroup(state, { sharedSlug: true });
  assert.equal((await state.request('put', `/api/articles/${ids[0]}`, { title: 'Before embargo' })).status, 200);
  const path = `/api/admin/workflow/${ids[2]}/embargo`;
  const deadline = new Date(Date.now() + 1000);
  const body = { embargoUntil: deadline.toISOString() };
  assert.equal((await state.request('post', path, body, null)).status, 401);
  assert.equal((await state.request('post', path, body, 'editor')).status, 403);
  assert.equal((await state.request('post', path, body)).status, 200);
  assert.ok(state.rows.News.every(doc => date(doc.publicVisibilityRefreshAt) === date(deadline)));
  assert.equal(state.rows.Article[0].translationStatus.gu, 'pending');
  assert.ok(!state.rows.Article[0].translations.gu?.content);
  assert.equal((await state.request('get', '/api/public/stories/shared-story?lang=gu', undefined, null)).status, 404);
  context.mock.timers.tick(999);
  assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 0);
  context.mock.timers.tick(1);
  assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 1);
  assert.equal((await state.request('get', '/api/public/stories/shared-story?lang=gu', undefined, null)).status, 200);
  assert.ok(state.rows.News.every(doc => date(doc.publishedAt) === date(publication)));
  assert.equal(state.rows.Article.length, 1);
});

for (const unlockBeforeExpiry of [false, true]) {
  test(`the existing lock/unlock endpoints preserve embargo eligibility when unlocking ${unlockBeforeExpiry ? 'before' : 'after'} expiry`, async context => {
    context.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { sharedSlug: true });
    const path = `/api/admin/workflow/${ids[2]}`;
    assert.equal((await state.request('put', `/api/articles/${ids[0]}`, { title: 'Before lock' })).status, 200);
    assert.equal((await state.request('post', `${path}/embargo`, { embargoUntil: new Date(Date.now() + 1000).toISOString() })).status, 200);
    assert.equal((await state.request('post', `${path}/lock`, {}, 'editor')).status, 403);
    assert.equal((await state.request('post', `${path}/lock`, {})).status, 200);
    assert.ok(state.rows.News.every(doc => doc.publicVisibilityRefreshAt === null));
    if (unlockBeforeExpiry) {
      assert.equal((await state.request('post', `${path}/unlock`, {})).status, 200);
      assert.equal(state.rows.Article[0].translationStatus.gu, 'pending');
      context.mock.timers.tick(1000);
      assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 1);
    } else {
      context.mock.timers.tick(1000);
      assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 0);
      assert.equal((await state.request('get', '/api/public/stories/shared-story?lang=gu', undefined, null)).status, 404);
      assert.equal((await state.request('post', `${path}/unlock`, {})).status, 200);
    }
    assert.equal(state.rows.Article[0].translationStatus.gu, 'ready');
    assert.equal((await state.request('get', '/api/public/stories/shared-story?lang=gu', undefined, null)).status, 200);
    assert.equal(state.rows.Article.length, 1);
  });
}

test('the embargo endpoint rolls back visibility and history on a failed copy sync, then retries safely', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  assert.equal((await state.request('put', `/api/articles/${ids[0]}`, { title: 'Before failed embargo' })).status, 200);
  const path = `/api/admin/workflow/${ids[2]}/embargo`;
  const body = { embargoUntil: new Date(Date.now() + 1000).toISOString() };
  state.failures['Article.findOneAndUpdate'] = { name: 'MongoNetworkError', once: true };
  assert.equal((await state.request('post', path, body)).status, 503);
  assert.equal(state.rows.News[2].embargoUntil, undefined);
  assert.equal(state.rows.News[2].workflowHistory.length, 0);
  assert.ok(state.rows.Article.every(doc => doc.translationStatus.gu === 'ready'));
  assert.equal((await state.request('post', path, body)).status, 200);
  assert.equal(state.rows.News[2].workflowHistory.at(-1).action, 'EMBARGO_SET');
  assert.ok(state.rows.Article.every(doc => doc.translationStatus.gu === 'pending'));
});

test('expiry refresh advances to the next locale deadline and respects overlapping embargoes', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { sharedSlug: true });
  const first = new Date(Date.now() + 1000);
  const second = new Date(Date.now() + 2000);
  state.rows.News[1].embargoUntil = first;
  state.rows.News[2].embargoUntil = first;
  state.rows.News[2].workflow = { embargoUntil: second };
  assert.equal((await state.request('put', `/api/articles/${ids[0]}`, { title: 'Two pending locales' })).status, 200);
  context.mock.timers.tick(1000);
  assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 1);
  assert.equal(state.rows.Article[0].translationStatus.hi, 'ready');
  assert.equal(state.rows.Article[0].translationStatus.gu, 'pending');
  assert.ok(state.rows.News.every(doc => date(doc.publicVisibilityRefreshAt) === date(second)));
  context.mock.timers.tick(1000);
  assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 1);
  assert.equal(state.rows.Article[0].translationStatus.gu, 'ready');
  assert.ok(state.rows.News.every(doc => doc.publicVisibilityRefreshAt === null));
});

for (const [label, gates] of [
  ['private', { isPrivate: true }],
  ['private visibility', { visibility: 'private' }],
  ['locked', { locked: true }],
  ['workflow locked', { workflow: { locked: true } }],
]) {
  test(`clock expiry rechecks a newly ${label} edition instead of exposing its cached content`, async context => {
    context.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { sharedSlug: true });
    state.rows.News[2].embargoUntil = new Date(Date.now() + 1000);
    assert.equal((await state.request('put', `/api/articles/${ids[0]}`, { title: 'Before restriction' })).status, 200);
    Object.assign(state.rows.News[2], gates);
    context.mock.timers.tick(1000);
    assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 1);
    assert.equal(state.rows.Article[0].translationStatus.gu, 'pending');
    assert.ok(!state.rows.Article[0].translations.gu?.content);
    assert.ok(state.rows.News.every(doc => doc.publicVisibilityRefreshAt === null));
    assert.equal((await state.request('get', '/api/public/stories/shared-story?lang=gu', undefined, null)).status, 404);
  });
}

test('failed expiry synchronization rolls back and the existing scheduler can retry it', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  const deadline = new Date(Date.now() + 1000);
  state.rows.News[2].embargoUntil = deadline;
  assert.equal((await state.request('put', `/api/articles/${ids[0]}`, { title: 'Expiry retry' })).status, 200);
  context.mock.timers.tick(1000);
  state.failures['Article.findOneAndUpdate'] = { name: 'MongoNetworkError', once: true };
  assert.deepEqual(await refreshDuePublicArticleVisibility(), { processed: 3, refreshed: 0, failed: 1, skipped: 2 });
  assert.ok(state.rows.News.every(doc => date(doc.publicVisibilityRefreshAt) === date(deadline)));
  assert.ok(state.rows.Article.every(doc => doc.translationStatus.gu === 'pending'));
  assert.equal(state.invalidations.length, 1);
  assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 1);
  assert.ok(state.rows.Article.every(doc => doc.translationStatus.gu === 'ready'));
  assert.equal(state.invalidations.length, 2);
});

for (const action of ['unpublish', 'soft delete', 'permanent delete']) {
  test(`clock expiry cannot republish or recreate a story after ${action}`, async context => {
    context.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00.000Z') });
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state);
    state.rows.News[2].embargoUntil = new Date(Date.now() + 1000);
    assert.equal((await state.request('put', `/api/articles/${ids[0]}`, { title: 'Pending expiry' })).status, 200);
    if (action === 'unpublish') {
      assert.equal((await state.request('post', `/api/articles/${ids[0]}/unpublish`, {})).status, 200);
    } else {
      assert.equal((await state.request('delete', `/api/articles/${ids[0]}`)).status, 200);
      if (action === 'permanent delete') {
        assert.equal((await state.request('delete', `/api/articles/${ids[0]}/permanent`)).status, 200);
      }
    }
    context.mock.timers.tick(1000);
    assert.equal((await refreshDuePublicArticleVisibility()).refreshed, 0);
    assert.equal(state.rows.News.length, action === 'permanent delete' ? 0 : 3);
    assert.equal(state.rows.Article.length, action === 'permanent delete' ? 0 : 3);
    assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === (action === 'unpublish' ? 'draft' : 'deleted')));
  });
}

test('Edit Published preserves dates, native editions, category identity and resynchronizes metadata and media', async context => {
  const state = installEditorialFixture(context);
  const { ids, publication } = seedGroup(state);
  state.rows.News[2].coverImage = { url: '/uploads/gu-custom.jpg', alt: 'Localized art' };
  const response = await state.request('put', `/api/articles/${ids[0]}`, {
    status: 'published', title: 'Revised English headline', summary: 'Revised summary',
    content: '<p>Revised English body</p>', tags: ['navratri-2026', 'updated'],
    coverImage: { url: '/uploads/new.jpg', alt: 'New shared image' }, seo: { metaTitle: 'Revised SEO' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(state.rows.News.length, 3);
  assert.equal(state.rows.Article.length, 3);
  assert.equal(state.rows.News[1].title, 'hi headline');
  assert.equal(state.rows.News[2].content, '<p>gu body</p>');
  assert.equal(state.rows.News[2].coverImage.url, '/uploads/gu-custom.jpg');
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    assert.equal(doc.status, 'published');
    assert.equal(date(doc.publishedAt), date(publication));
    assert.equal(doc.category, 'faith-culture');
    assert.deepEqual(doc.tags, ['navratri-2026', 'updated']);
  }
  const copy = state.rows.Article.find(doc => doc.sourceNewsId === ids[0]);
  assert.equal(copy.title, 'Revised English headline');
  assert.equal(copy.summary, 'Revised summary');
  assert.equal(copy.coverImage.url, '/uploads/new.jpg');
  assert.equal(copy.seo.metaTitle, 'Revised SEO');
  assert.equal(state.rows.TranslationJob.length, 0);
  const pin = (await getPublicTopic('navratri-2026', { lang: 'gu' })).pinnedArticle;
  assert.equal(pin.category, 'faith-culture');
  assert.equal(pin.slug, 'story-gu');
});

test('editing a translated edition adds/removes exact topic membership and invalidates the old pin without changing category', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  let response = await state.request('patch', `/api/articles/${ids[1]}`, { tags: [] });
  assert.equal(response.statusCode, 200);
  assert.ok(state.rows.News.every(doc => doc.tags.length === 0 && doc.category === 'faith-culture'));
  assert.equal((await getPublicTopic('navratri-2026', { lang: 'gu' })).pinnedArticle, null);
  assert.equal((await listTopicStories('navratri-2026', { lang: 'gu' })).total, 0);
  assert.ok(state.invalidations.at(-1).paths.includes('/topic/navratri-2026'));
  response = await state.request('patch', `/api/articles/${ids[2]}`, { tags: ['navratri-2026'] });
  assert.equal(response.statusCode, 200);
  assert.ok((await getPublicTopic('navratri-2026', { lang: 'hi' })).pinnedArticle);
});

test('Published list forces publishedAt DESC then _id DESC before pagination and shares its count filter', async context => {
  const state = installEditorialFixture(context);
  seedGroup(state);
  const old = state.rows.News[0];
  old.updatedAt = new Date();
  state.rows.News.push({
    ...old, _id: '507f1f77bcf86cd79943f999', translationGroupId: 'new-story', translationKey: 'new-story',
    sourceArticleId: null, slug: 'new-story', publishedAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  });
  const response = await state.request('get', '/admin-api/articles?status=published&language=en&sort=-updatedAt&page=1&limit=1');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.total, 2);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0]._id, '507f1f77bcf86cd79943f999');
  assert.deepEqual(response.body.sort, { publishedAt: -1, _id: -1 });
  assert.deepEqual(state.calls.find(call => call.name === 'News' && call.method === 'find').filter,
    state.calls.find(call => call.name === 'News' && call.method === 'countDocuments').filter);
});

test('Draft/Deleted list filters and status=all retain correct totals without admitting missing-status records into Published', async context => {
  const state = installEditorialFixture(context);
  seedGroup(state, { status: 'draft' });
  state.rows.News.push({ _id: '507f1f77bcf86cd79943f111', title: 'Legacy draft' });
  let response = await state.request('get', '/admin-api/articles?status=published');
  assert.equal(response.body.total, 0);
  response = await state.request('get', '/admin-api/articles?status=draft');
  assert.equal(response.body.total, 4);
  response = await state.request('get', '/admin-api/articles?status=deleted');
  assert.equal(response.body.total, 0);
  response = await state.request('get', '/admin-api/articles?status=all');
  assert.equal(response.body.total, 4);
});

for (const [method, error, expected] of [
  ['find', { name: 'MongoNetworkError' }, 503],
  ['countDocuments', { code: 50 }, 503],
  ['find', { name: 'TypeError' }, 500],
]) {
  test(`admin ${method} ${error.name || 'deadline'} failure is not a successful empty list`, async context => {
    const state = installEditorialFixture(context);
    seedGroup(state);
    state.failures[`News.${method}`] = error;
    const response = await state.request('get', '/admin-api/articles?status=published');
    assert.equal(response.statusCode, expected);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.items, undefined);
    assert.equal(response.body.total, undefined);
  });
}

test('public database failures are 503, whereas a genuinely empty feed remains 200', async context => {
  const state = installEditorialFixture(context);
  let response = await state.request('get', '/api/public/news?lang=gu', undefined, null);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.total, 0);
  mongoose.connection.readyState = 0;
  for (const path of [
    '/api/public/news?lang=gu', '/api/public/news?category=faith-culture&lang=gu&strictLocale=true',
    '/api/public/news/slug/missing', '/api/public/news/missing', '/api/public/news/translations/group',
  ]) {
    response = await state.request('get', path, undefined, null);
    assert.equal(response.statusCode, 503, path);
    assert.equal(response.body.items, undefined, path);
    assert.equal(response.body.total, undefined, path);
  }
});

test('strictLocale does not fall back, and a Faith aggregation timeout is not zero stories', async context => {
  const state = installEditorialFixture(context);
  seedGroup(state);
  state.rows.News = [state.rows.News[0]];
  for (const category of ['faith-culture', 'national']) {
    state.rows.News[0].category = category;
    const response = await state.request('get', `/api/public/news?category=${category}&lang=gu&strictLocale=true&fallback=true`, undefined, null);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.items.length, 0);
    assert.equal(response.body.total, 0);
  }
  state.failures['News.aggregate'] = { code: 50 };
  const response = await state.request('get', '/api/public/news?category=faith-culture&lang=gu&strictLocale=true', undefined, null);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.total, undefined);
});

test('a stale compatibility Article cannot revive its hidden canonical News source', async context => {
  const state = installEditorialFixture(context);
  seedGroup(state);
  state.rows.News.forEach(doc => { doc.status = 'draft'; });
  for (const path of ['/api/public/news/story-en', '/api/public/stories/story-en', '/api/articles/story-en']) {
    const response = await state.request('get', path, undefined, null);
    assert.equal(response.statusCode, 404, path);
  }
});

test('restore to Published is Founder-only; a draft-only story can be restored by an editor', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  assert.equal((await state.request('delete', `/api/articles/${ids[0]}`)).statusCode, 200);
  const denied = await state.request('post', `/api/articles/${ids[1]}/restore`, {}, 'editor');
  assert.equal(denied.statusCode, 403);
  assert.ok(state.rows.News.every(doc => doc.status === 'deleted'));
  state.rows.News.forEach(doc => { doc.deletedFromStatus = 'draft'; doc.publishedAt = null; });
  const restored = await state.request('post', `/api/articles/${ids[1]}/restore`, {}, 'editor');
  assert.equal(restored.statusCode, 200);
  assert.ok(state.rows.News.every(doc => doc.status === 'draft'));
});

test('restore rejects a duplicate language and never inserts a second News record', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'deleted' });
  state.rows.News.push({ ...state.rows.News[1], _id: '507f1f77bcf86cd79943b001' });
  const response = await state.request('post', `/api/articles/${ids[0]}/restore`, {});
  assert.equal(response.statusCode, 409);
  assert.equal(state.rows.News.length, 4);
  assert.ok(state.rows.News.every(doc => doc.status === 'deleted'));
});

for (const prefix of ['', '/api', '/api/admin', '/admin-api', '/admin-api/admin', '/admin-api/api', '/admin-api/api/admin']) {
  test(`all permanent-delete aliases at ${prefix || 'root'} require authenticated Founder authority`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: 'deleted' });
    const variants = [
      ...['permanent', 'hard-delete', 'hard', 'forever'].map(suffix => ['delete', `/articles/${ids[0]}/${suffix}`]),
      ...['hard-delete', 'hard'].map(suffix => ['post', `/articles/${ids[0]}/${suffix}`]),
      ['delete', `/articles/${ids[0]}?hard=true`],
      ['post', '/articles/forever/bulk'],
      ['delete', '/articles/forever/all-deleted'],
    ];
    for (const [method, path] of variants) {
      const body = method === 'post' ? { ids: [ids[0]] } : undefined;
      assert.equal((await state.request(method, prefix + path, body, null)).statusCode, 401, path);
      assert.equal((await state.request(method, prefix + path, body, 'editor')).statusCode, 403, path);
    }
    assert.equal(state.rows.News.length, 3);
    assert.equal(state.rows.Article.length, 3);
    assert.equal(state.transactions.length, 0);
  });
}

for (const [method, suffix] of [['delete', 'permanent'], ['delete', 'hard-delete'], ['delete', 'hard'], ['delete', 'forever'], ['post', 'hard-delete'], ['post', 'hard']]) {
  test(`${method} ${suffix} permanently deletes the group, copies and jobs, detaches pins, and retains minimal audit metadata`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: 'deleted' });
    state.rows.TranslationJob.push({ _id: 'job', newsId: ids[1] }, { _id: 'unrelated', newsId: '507f1f77bcf86cd79943fffff' });
    const response = await state.request(method, `/api/articles/${ids[2]}/${suffix}`, method === 'post' ? {} : undefined);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.deletedCount, 3);
    assert.equal(state.rows.News.length, 0);
    assert.equal(state.rows.Article.length, 0);
    assert.equal(state.rows.EditorialTopic[0].pinnedArticleId, null);
    assert.deepEqual(state.rows.TranslationJob.map(job => job._id), ['unrelated']);
    assert.equal(state.rows.AuditLog.length, 1);
    assert.equal(state.rows.AuditLog[0].meta.articleIds.length, 3);
    assert.equal(state.rows.AuditLog[0].meta.content, undefined);
    assert.ok(state.transactions[0].committed && state.transactions[0].ended);
    assert.ok(state.invalidations[0].paths.includes('/topic/navratri-2026'));
  });
}

test('permanent delete rejects a live sibling and rolls back all cleanup when a database write fails', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'deleted' });
  state.rows.News[1].status = 'published';
  let response = await state.request('delete', `/api/articles/${ids[0]}/permanent`);
  assert.equal(response.statusCode, 409);
  assert.equal(state.rows.News.length, 3);
  state.rows.News[1].status = 'deleted';
  state.failures['News.deleteMany'] = { name: 'MongoNetworkError' };
  response = await state.request('delete', `/api/articles/${ids[0]}/permanent`);
  assert.equal(response.statusCode, 503);
  assert.equal(state.rows.News.length, 3);
  assert.equal(state.rows.Article.length, 3);
  assert.equal(state.rows.EditorialTopic[0].pinnedArticleId, ids[0]);
  assert.ok(state.transactions.at(-1).aborted && state.transactions.at(-1).ended);
  assert.equal(state.invalidations.length, 0);
});

test('bulk permanent deletion expands and deduplicates logical stories', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'deleted' });
  const response = await state.request('post', '/admin-api/articles/forever/bulk', { ids: [ids[0], ids[1], ids[0]] });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.deletedCount, 3);
});

test('public synchronization failure aborts Restore instead of returning success', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  assert.equal((await state.request('delete', `/api/articles/${ids[0]}`)).statusCode, 200);
  state.failures['Article.findOneAndUpdate'] = { name: 'MongoNetworkError' };
  const response = await state.request('post', `/api/articles/${ids[0]}/restore`, {});
  assert.equal(response.statusCode, 503);
  assert.ok(state.rows.News.every(doc => doc.status === 'deleted'));
  assert.ok(state.rows.Article.every(doc => doc.status === 'deleted'));
});

test('paid articles and combo-linked records never enter normal Top Story selection; Business journalism still qualifies', async context => {
  const state = installEditorialFixture(context);
  const { _private: ranking } = require('../controllers/publicSponsoredFeaturesController');
  const now = new Date();
  const common = { status: 'published', publishedAt: now, category: 'business', spotlightPriority: 'high', title: 'Story', summary: 'Summary' };
  const docs = [
    { ...common, _id: '507f1f77bcf86cd79943a011' },
    { ...common, _id: '507f1f77bcf86cd79943a012', isSponsored: true },
    { ...common, _id: '507f1f77bcf86cd79943a013', isSponsoredArticle: true },
    { ...common, _id: '507f1f77bcf86cd79943a014', sponsorFeatureLinkedId: '507f1f77bcf86cd79943a099' },
    { ...common, _id: '507f1f77bcf86cd79943a015', category: 'sponsored-content' },
  ];
  assert.deepEqual(docs.filter(doc => matches(doc, ranking.buildFreshSpotlightFilter(now, 24))).map(doc => doc._id), [docs[0]._id]);
  assert.deepEqual(ranking.selectCategoryBalancedSpotlight(docs).map(doc => doc._id), [docs[0]._id]);
  state.rows.Article.push(...docs);
  const response = await state.request('get', '/api/public/homepage/center-slot', undefined, null);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.items.length, 1);
  mongoose.connection.readyState = 0;
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  context.after(() => { process.env.NODE_ENV = previousEnv; });
  const unavailable = await state.request('get', '/api/public/homepage/center-slot', undefined, null);
  assert.equal(unavailable.statusCode, 200);
  assert.equal(unavailable.body.selectedSource, 'safe-default');
  assert.ok(unavailable.body.item);
});

test('scheduler uses the canonical publisher once per logical group for ordinary editorial stories', async context => {
  const state = installEditorialFixture(context);
  seedGroup(state, { status: 'scheduled' });
  state.rows.News.forEach(doc => { doc.scheduledAt = new Date('2026-01-01T00:00:00.000Z'); });
  const calls = [];
  const result = await publishDueScheduledArticles({
    publishCanonicalArticle: async (doc, options) => { calls.push({ doc, options }); return { ok: true }; },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(result, { processed: 3, published: 1, failed: 0, skipped: 2 });
});

for (const toStatus of ['draft', 'archived']) {
  test(`republishing after ${toStatus} preserves original dates across repeated lifecycle changes`, async context => {
    const state = installEditorialFixture(context);
    const { ids, publication } = seedGroup(state);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await state.request('post', `/api/articles/${ids[0]}/unpublish`, { toStatus })).statusCode, 200);
      assert.equal((await state.request('patch', `/api/articles/${ids[1]}`, { status: 'published' })).statusCode, 200);
      for (const doc of [...state.rows.News, ...state.rows.Article]) {
        assert.equal(doc.status, 'published');
        assert.equal(date(doc.publishedAt), date(publication));
      }
    }
    assert.equal(state.rows.News.length, 3);
    assert.equal(state.rows.Article.length, 3);
    assert.ok(state.rows.PushHistory.some(entry => entry.action === (toStatus === 'draft' ? 'unpublish' : 'archive')));
  });
}

for (const field of ['slug', 'slugs.en', 'slugs.hi', 'slugs.gu']) {
  test(`status-only Publish rejects an unrelated ${field} collision without publishing any edition`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: 'draft' });
    const other = { _id: '507f1f77bcf86cd79943c999', slug: 'unrelated-story', status: 'draft' };
    if (field === 'slug') other.slug = 'story-en';
    else other.slugs = { [field.slice(6)]: 'story-en' };
    state.rows.News.push(other);
    const response = await state.request('patch', `/api/articles/${ids[0]}`, { status: 'published' });
    assert.equal(response.statusCode, 409);
    assert.ok(state.rows.News.every(doc => doc.status === 'draft'));
    assert.ok(state.rows.Article.every(doc => doc.status === 'draft'));
  });
}

test('newly filled locale aliases are checked before they are persisted during Publish', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'draft' });
  delete state.rows.News[1].slugs.hi;
  state.rows.News.push({ _id: '507f1f77bcf86cd79943c999', slug: 'hi-headline', status: 'draft' });
  const response = await state.request('patch', `/api/articles/${ids[0]}`, { status: 'published' });
  assert.equal(response.statusCode, 409);
  assert.equal(state.rows.News[1].slugs.hi, undefined);
  assert.ok(state.rows.News.every(doc => doc.status === 'draft'));
});

test('a public-copy failure during Publish returns failure and rolls visibility back', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'draft' });
  state.failures['Article.findOneAndUpdate'] = { name: 'MongoNetworkError', once: true };
  const response = await state.request('post', `/api/articles/${ids[0]}/publish`, {});
  assert.equal(response.statusCode, 503);
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    assert.equal(doc.status, 'draft');
    assert.equal(doc.publishedAt, null);
  }
});

test('editing through a public Article ID updates the canonical News edition and complete story metadata', async context => {
  const state = installEditorialFixture(context);
  const { publication } = seedGroup(state);
  const copyId = state.rows.Article[1]._id;
  const response = await state.request('patch', `/api/articles/${copyId}`, {
    title: 'Revised Hindi edition', tags: ['navratri-2026', 'revised'],
  });
  assert.equal(response.statusCode, 200);
  assert.equal(state.rows.News[1].title, 'Revised Hindi edition');
  assert.equal(state.rows.News[0].title, 'en headline');
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    assert.deepEqual(doc.tags, ['navratri-2026', 'revised']);
    assert.equal(date(doc.publishedAt), date(publication));
  }
});

for (const status of ['published', 'draft']) {
  test(`content edits combined with ${status} synchronize metadata and status across the story`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: status === 'published' ? 'draft' : 'published' });
    const response = await state.request('patch', `/api/articles/${ids[0]}`, {
      status, title: 'Revised English edition', tags: ['new-topic'], category: 'business',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(state.rows.News[1].title, 'hi headline');
    for (const doc of [...state.rows.News, ...state.rows.Article]) {
      assert.equal(doc.status, status);
      assert.equal(doc.category, 'business');
      assert.deepEqual(doc.tags, ['new-topic']);
    }
  });
}

test('renaming an unowned legacy copy reuses it and invalidates old and new detail, category and topic paths', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  const copyId = state.rows.Article[0]._id;
  delete state.rows.Article[0].sourceNewsId;
  delete state.rows.Article[0].sourceArticleId;
  delete state.rows.Article[0].translationGroupId;
  delete state.rows.Article[0].translationKey;
  state.rows.EditorialTopic.push({
    _id: '507f1f77bcf86cd79943c999', slug: 'new-topic', articleTags: ['new-topic'], isActive: true,
  });
  const response = await state.request('patch', `/api/articles/${ids[0]}`, {
    slug: 'renamed-story', category: 'business', tags: ['new-topic'],
    coverImage: { url: '/uploads/replacement.jpg', alt: 'New image' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(state.rows.Article.length, 3);
  assert.equal(state.rows.Article.find(doc => doc._id === copyId).slug, 'renamed-story');
  const { paths, tags } = state.invalidations.at(-1);
  for (const path of [
    '/', '/hi', '/gu', '/latest', '/hi/latest', '/gu/latest', '/search',
    '/news/story-en', '/news/renamed-story',
    '/category/faith-culture', '/category/business', '/hi/category/business', '/gu/category/business',
    '/topic/navratri-2026', '/hi/topic/navratri-2026', '/gu/topic/navratri-2026',
    '/topic/new-topic', '/hi/topic/new-topic', '/gu/topic/new-topic',
  ]) assert.ok(paths.includes(path), path);
  for (const tag of ['article-detail', 'homepage', 'latest-stories', 'related-stories', 'search', 'editorial-topics']) {
    assert.ok(tags.includes(tag), tag);
  }
});

test('shared metadata edits invalidate previous categories and topic tags from every native edition', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  state.rows.News[1].category = 'business';
  state.rows.News[1].tags = ['legacy-hindi-topic'];
  state.rows.EditorialTopic.push({
    _id: '507f1f77bcf86cd79943c998', slug: 'legacy-hindi-topic', articleTags: ['legacy-hindi-topic'], active: true,
  }, {
    _id: '507f1f77bcf86cd79943c999', slug: 'new-topic', articleTags: ['new-topic'], active: true,
  });
  const response = await state.request('put', `/api/articles/${ids[0]}`, {
    category: 'national', tags: ['new-topic'],
  });
  assert.equal(response.status, 200);
  const { paths } = state.invalidations.at(-1);
  for (const path of [
    '/category/faith-culture', '/category/business', '/category/national',
    '/topic/navratri-2026', '/topic/legacy-hindi-topic', '/topic/new-topic',
  ]) assert.ok(paths.includes(path), path);
  assert.ok(state.rows.News.every(doc => doc.category === 'national' && doc.tags.includes('new-topic')));
});

test('legacy repeated deletion history restores the last usable pre-delete state', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'deleted' });
  for (const doc of state.rows.News) {
    delete doc.deletedFromStatus;
    doc.workflowHistory = [
      { action: 'REJECT', fromStage: 'published', toStage: 'REJECTED' },
      { action: 'REJECT', fromStage: 'REJECTED', toStage: 'REJECTED' },
    ];
  }
  const response = await state.request('post', `/api/articles/${ids[0]}/restore`, {});
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.restoreFallbackIds, []);
  assert.ok(state.rows.News.every(doc => doc.status === 'published'));
});

test('unknown legacy pre-delete status is surfaced explicitly and restored safely to Draft', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'deleted' });
  state.rows.News.forEach(doc => { delete doc.deletedFromStatus; doc.workflowHistory = []; });
  const warnings = [];
  context.mock.method(console, 'warn', (...args) => warnings.push(args));
  const response = await state.request('post', `/api/articles/${ids[0]}/restore`, {}, 'editor');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.restoreFallbackIds.sort(), [...ids].sort());
  assert.ok(state.rows.News.every(doc => doc.status === 'draft'));
  assert.ok(warnings.some(args => String(args[0]).includes('pre-delete status unknown')));
});

test('mixed pre-delete statuses restore exactly without exposing private languages in a shared compatibility copy', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'deleted', sharedSlug: true });
  state.rows.News[0].deletedFromStatus = 'published';
  state.rows.News[1].deletedFromStatus = 'draft';
  state.rows.News[2].deletedFromStatus = 'scheduled';
  state.rows.Article[0].translations = { hi: { title: 'Private draft', summary: 'Private', content: 'Private' } };
  const response = await state.request('post', `/api/articles/${ids[0]}/restore`, {});
  assert.equal(response.statusCode, 200);
  assert.deepEqual(state.rows.News.map(doc => doc.status), ['published', 'draft', 'scheduled']);
  assert.equal(state.rows.Article.length, 1);
  assert.equal(state.rows.Article[0].status, 'published');
  for (const language of ['hi', 'gu']) {
    assert.equal(state.rows.Article[0].translationStatus[language], 'pending');
    for (const field of ['title', 'summary', 'content']) {
      assert.equal(state.rows.Article[0].translations[language][field], null);
    }
  }
});

test('all-deleted deletion refuses mixed live groups and removes the complete group once all editions are deleted', async context => {
  const state = installEditorialFixture(context);
  seedGroup(state, { status: 'deleted' });
  state.rows.News[1].status = 'published';
  let response = await state.request('delete', '/api/articles/forever/all-deleted');
  assert.equal(response.statusCode, 409);
  assert.equal(state.rows.News.length, 3);
  state.rows.News[1].status = 'deleted';
  response = await state.request('delete', '/api/articles/forever/all-deleted');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.deletedCount, 3);
  assert.equal(state.rows.News.length, 0);
  assert.equal(state.rows.Article.length, 0);
});

test('workflow-stage publishing is Founder-only and uses the group publisher without resetting dates', async context => {
  const state = installEditorialFixture(context);
  const { ids, publication } = seedGroup(state);
  await state.request('post', `/api/articles/${ids[0]}/unpublish`, {});
  const path = `/api/admin/workflow/articles/${ids[1]}/stage`;
  assert.equal((await state.request('patch', path, { action: 'set', toStage: 'published' }, 'admin')).statusCode, 403);
  assert.ok(state.rows.News.every(doc => doc.status === 'draft'));
  const response = await state.request('patch', path, { action: 'set', toStage: 'published' });
  assert.equal(response.statusCode, 200);
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    assert.equal(doc.status, 'published');
    assert.equal(date(doc.publishedAt), date(publication));
  }
  assert.equal((await state.request('patch', path, { action: 'set', toStage: 'draft' })).statusCode, 200);
  assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === 'draft'));
});

test('canonical create rejects a genuine slug collision', async context => {
  const state = installEditorialFixture(context);
  seedGroup(state);
  const body = {
    title: 'New story', summary: 'New summary', content: '<p>New content</p>',
    category: 'business', language: 'en', slug: 'story-en', status: 'draft',
  };
  assert.equal((await state.request('post', '/api/articles', body)).statusCode, 409);
  assert.equal(state.rows.News.length, 3);
});

test('revalidation failure reports a committed lifecycle change without inviting a duplicate mutation', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  context.mock.method(global, 'fetch', async () => ({ ok: false, status: 503, text: async () => '' }));
  const response = await state.request('post', `/api/articles/${ids[0]}/unpublish`, {});
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.committed, true);
  assert.equal(response.body.revalidation.ok, false);
  assert.match(response.body.revalidation.message, /do not repeat the mutation/);
  assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === 'draft'));
});

test('failed permanent-delete revalidation reports the committed state without echoing webhook details', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'deleted' });
  let responseBodyRead = false;
  const warnings = [];
  context.mock.method(console, 'warn', (...args) => warnings.push(args));
  context.mock.method(global, 'fetch', async () => ({
    ok: false, status: 503,
    text: async () => { responseBodyRead = true; return 'external-response-detail'; },
  }));
  const response = await state.request('delete', `/api/articles/${ids[0]}/permanent`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 200);
  assert.equal(response.body.committed, true);
  assert.equal(response.body.revalidation.ok, false);
  assert.equal(response.body.deletedCount, 3);
  assert.equal(state.rows.News.length, 0);
  assert.equal(state.rows.Article.length, 0);
  assert.equal(responseBodyRead, false);
  assert.equal(JSON.stringify(warnings).includes('external-response-detail'), false);
});

for (const permanentlyDelete of [false, true]) {
  test(`an in-flight translation cannot recreate an edition after ${permanentlyDelete ? 'permanent' : 'soft'} deletion`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state);
    state.rows.News = state.rows.News.filter(doc => doc.language !== 'hi');
    const source = state.newsDoc(ids[0]);
    const previousDb = mongoose.connection.db;
    mongoose.connection.db = {};
    context.after(() => { mongoose.connection.db = previousDb; });
    const google = require('../services/googleTranslationService');
    const { generateArticleTranslations } = require('../services/articleTranslationGeneration.service');
    let interrupted = false;
    context.mock.method(google, 'translateText', async () => {
      if (!interrupted) {
        interrupted = true;
        assert.equal((await state.request('delete', `/api/articles/${ids[0]}`)).statusCode, 200);
        if (permanentlyDelete) {
          assert.equal((await state.request('delete', `/api/articles/${ids[0]}/permanent`)).statusCode, 200);
        }
      }
      return { ok: true, text: 'Hindi translation' };
    });
    await assert.rejects(generateArticleTranslations(source, { targetLanguages: ['hi'] }), {
      statusCode: 409, code: 'TRANSLATION_SOURCE_CHANGED',
    });
    assert.equal(state.rows.News.some(doc => doc.language === 'hi'), false);
    if (permanentlyDelete) {
      assert.equal(state.rows.News.length, 0);
      assert.equal(state.rows.Article.length, 0);
      assert.equal(state.rows.TranslationJob.length, 0);
    } else assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === 'deleted'));
  });
}

test('generated editions use localized slugs and published regeneration preserves chronology and cached native content', async context => {
  const state = installEditorialFixture(context);
  const { ids, publication } = seedGroup(state);
  state.rows.News = state.rows.News.filter(doc => doc.language !== 'hi');
  state.rows.Article = state.rows.Article.filter(doc => doc.sourceNewsId !== ids[1]);
  delete state.rows.News[0].slugs.hi;
  const google = require('../services/googleTranslationService');
  const { generateArticleTranslations } = require('../services/articleTranslationGeneration.service');
  context.mock.method(google, 'translateText', async (_text, _from, to) => ({ ok: true, text: `${to} translated text` }));
  const generated = await generateArticleTranslations(state.newsDoc(ids[0]), { targetLanguages: ['hi'] });
  assert.equal(generated.ok, true);
  const child = state.rows.News.find(doc => doc.language === 'hi');
  assert.equal(child.slug, 'hi-translated-text');
  child.status = 'published';
  child.publishedAt = publication;
  const updated = await generateArticleTranslations(state.newsDoc(ids[0]), {
    targetLanguages: ['hi'], overwrite: true, confirmOverwriteHumanEdited: true,
  });
  assert.equal(updated.ok, true);
  assert.equal(state.rows.News.filter(doc => doc.language === 'hi').length, 1);
  assert.equal(date(state.rows.News.find(doc => doc.language === 'hi').publishedAt), date(publication));
  assert.equal(state.rows.News[0].translations.hi.title, 'hi translated text');
  assert.equal(state.rows.Article.find(doc => doc.sourceNewsId === ids[0]).translations.hi.title, 'hi translated text');
});

test('stale asynchronous master synchronization cannot undo an Unpublish or revive a deleted group', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  const stale = state.newsDoc(ids[0]).toObject();
  const { syncTranslationGroupFromMaster } = require('../services/translationGroupSync.service');
  await state.request('post', `/api/articles/${ids[0]}/unpublish`, {});
  await syncTranslationGroupFromMaster(stale);
  assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === 'draft'));
  await state.request('delete', `/api/articles/${ids[0]}`);
  await assert.rejects(syncTranslationGroupFromMaster(stale), { statusCode: 409, code: 'TRANSLATION_SOURCE_CHANGED' });
  assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === 'deleted'));
});
