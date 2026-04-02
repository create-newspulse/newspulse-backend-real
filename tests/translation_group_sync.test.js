const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeContentFingerprint,
  normalizeTranslationGroupKey,
  isChildLinkedToMaster,
  prepareSourceSyncMetadata,
  buildChildNewsSyncPatch,
} = require('../services/translationGroupSync.service');

test('normalizeTranslationGroupKey rejects empty and placeholder values', () => {
  assert.equal(normalizeTranslationGroupKey('group-1'), 'group-1');
  assert.equal(normalizeTranslationGroupKey('  group-2  '), 'group-2');
  assert.equal(normalizeTranslationGroupKey(''), null);
  assert.equal(normalizeTranslationGroupKey('   '), null);
  assert.equal(normalizeTranslationGroupKey('null'), null);
  assert.equal(normalizeTranslationGroupKey('undefined'), null);
  assert.equal(normalizeTranslationGroupKey(null), null);
});

test('isChildLinkedToMaster only allows unlinked or explicitly linked children', () => {
  const master = { _id: '69c832dfa5f8e74cf2bf87b7' };

  assert.equal(isChildLinkedToMaster(master, { _id: '69c832dfa5f8e74cf2bf87b8', sourceArticleId: null }), true);
  assert.equal(isChildLinkedToMaster(master, { _id: '69c832dfa5f8e74cf2bf87b8', sourceArticleId: '69c832dfa5f8e74cf2bf87b7' }), true);
  assert.equal(isChildLinkedToMaster(master, { _id: '69c832dfa5f8e74cf2bf87b8', sourceArticleId: '69c832dfa5f8e74cf2bf87b8' }), false);
  assert.equal(isChildLinkedToMaster(master, { _id: '69c832dfa5f8e74cf2bf87b8', sourceArticleId: '69c832dfa5f8e74cf2bf9000' }), false);
});

test('prepareSourceSyncMetadata stamps auto sync metadata and fingerprint', () => {
  const now = new Date('2026-03-29T10:00:00.000Z');
  const meta = prepareSourceSyncMetadata({
    _id: '69c832dfa5f8e74cf2bf87b7',
    title: 'Master title',
    description: 'Master summary',
    content: '<p>Master body</p>',
    lang: 'en',
    translationGroupId: 'group-1',
    syncVersion: 4,
  }, { now });

  assert.equal(meta.syncMode, 'auto');
  assert.equal(String(meta.sourceArticleId), '69c832dfa5f8e74cf2bf87b7');
  assert.equal(meta.sourceLanguage, 'en');
  assert.equal(meta.lastSyncedAt.toISOString(), now.toISOString());
  assert.equal(meta.syncVersion, 5);
  assert.equal(typeof meta.contentFingerprint, 'string');
  assert.equal(meta.contentFingerprint.length, 64);
  assert.equal(meta.contentFingerprint, computeContentFingerprint({
    _id: '69c832dfa5f8e74cf2bf87b7',
    title: 'Master title',
    description: 'Master summary',
    content: '<p>Master body</p>',
    lang: 'en',
    sourceLanguage: 'en',
  }));
});

test('buildChildNewsSyncPatch clears stale child content when translated locale is not ready', () => {
  const now = new Date('2026-03-29T11:00:00.000Z');
  const metadata = prepareSourceSyncMetadata({
    _id: '69c832dfa5f8e74cf2bf87b7',
    title: 'Master title',
    description: 'Master summary',
    content: '<p>Master body cleaned</p>',
    lang: 'en',
    status: 'published',
    category: 'tech',
    tags: ['science', 'water'],
    slugs: { en: 'master-en', hi: 'master-hi' },
    location: { state: 'Gujarat', stateSlug: 'gujarat' },
    translationGroupId: 'group-1',
    translations: {
      en: { title: 'Master title', summary: 'Master summary', content: '<p>Master body cleaned</p>' },
      hi: { title: '', summary: '', content: '' },
    },
    translationStatus: { en: 'ready', hi: 'pending' },
  }, { now });

  const patch = buildChildNewsSyncPatch({
    _id: '69c832dfa5f8e74cf2bf87b7',
    title: 'Master title',
    description: 'Master summary',
    content: '<p>Master body cleaned</p>',
    lang: 'en',
    originalLang: 'en',
    status: 'published',
    category: 'tech',
    tags: ['science', 'water'],
    slugs: { en: 'master-en', hi: 'master-hi' },
    location: { state: 'Gujarat', stateSlug: 'gujarat' },
    translationGroupId: 'group-1',
    translations: {
      en: { title: 'Master title', summary: 'Master summary', content: '<p>Master body cleaned</p>' },
      hi: { title: '', summary: '', content: '' },
    },
    translationStatus: { en: 'ready', hi: 'pending' },
  }, {
    _id: '69c832dfa5f8e74cf2bf87b8',
    lang: 'hi',
    language: 'hi',
    originalLang: 'hi',
    status: 'published',
  }, { now, metadata });

  assert.equal(patch.status, 'draft');
  assert.equal(patch.title, '');
  assert.equal(patch.description, '');
  assert.equal(patch.content, '');
  assert.equal(patch.slug, 'master-hi');
  assert.equal(patch.category, 'tech');
  assert.deepEqual(patch.tags, ['science', 'water']);
  assert.equal(String(patch.sourceArticleId), '69c832dfa5f8e74cf2bf87b7');
  assert.equal(patch.sourceLanguage, 'en');
  assert.equal(patch.syncMode, 'auto');
  assert.equal(patch.syncVersion, metadata.syncVersion);
  assert.equal(patch.publishedAt, null);
});

test('buildChildNewsSyncPatch publishes localized child when translated bucket is ready and keeps child cover fields', () => {
  const now = new Date('2026-03-29T12:00:00.000Z');
  const master = {
    _id: '69c832dfa5f8e74cf2bf87b7',
    title: 'Master title',
    description: 'Master summary',
    content: '<p>Master body</p>',
    lang: 'en',
    originalLang: 'en',
    status: 'published',
    publishedAt: new Date('2026-03-29T09:00:00.000Z'),
    category: 'tech',
    tags: ['science', 'water'],
    stateTags: ['state:gujarat'],
    stateNames: ['Gujarat'],
    slugs: { en: 'master-en', gu: 'master-gu' },
    coverImage: { url: 'https://example.com/cover.jpg', publicId: 'cover-1', alt: 'Cover' },
    coverImageUrl: 'https://example.com/cover.jpg',
    imageURL: 'https://example.com/cover.jpg',
    externalUrls: ['https://example.com/source'],
    embeds: ['https://youtube.com/embed/demo'],
    gallery: ['https://example.com/gallery-1.jpg'],
    seo: { metaTitle: 'SEO Title', metaDescription: 'SEO Description', canonicalUrl: 'https://newspulse.com/story' },
    location: { state: 'Gujarat', stateSlug: 'gujarat', city: 'Ahmedabad', citySlug: 'ahmedabad' },
    geo: { state: 'gujarat', city: 'ahmedabad' },
    translationGroupId: 'group-1',
    translations: {
      en: { title: 'Master title', summary: 'Master summary', content: '<p>Master body</p>' },
      gu: { title: 'ગુજરાતી શીર્ષક', summary: 'ગુજરાતી સાર', content: '<p>ગુજરાતી લેખ</p>', generatedAt: now, provider: 'google' },
    },
    translationStatus: { en: 'ready', gu: 'ready' },
  };
  const metadata = prepareSourceSyncMetadata(master, { now });
  const patch = buildChildNewsSyncPatch(master, {
    _id: '69c832dfa5f8e74cf2bf87b9',
    lang: 'gu',
    language: 'gu',
    originalLang: 'gu',
    coverImage: { url: 'https://example.com/child-cover.jpg', publicId: 'child-cover', alt: 'Child cover' },
    coverImageUrl: 'https://example.com/child-cover.jpg',
    imageURL: 'https://example.com/child-cover.jpg',
  }, { now, metadata });

  assert.equal(patch.status, 'published');
  assert.equal(patch.title, 'ગુજરાતી શીર્ષક');
  assert.equal(patch.description, 'ગુજરાતી સાર');
  assert.equal(patch.content, '<p>ગુજરાતી લેખ</p>');
  assert.equal(patch.slug, 'master-gu');
  assert.deepEqual(patch.seo, {
    metaTitle: 'SEO Title',
    metaDescription: 'SEO Description',
    canonicalUrl: 'https://newspulse.com/story',
  });
  assert.deepEqual(patch.externalUrls, ['https://example.com/source']);
  assert.deepEqual(patch.embeds, ['https://youtube.com/embed/demo']);
  assert.deepEqual(patch.gallery, ['https://example.com/gallery-1.jpg']);
  assert.deepEqual(patch.coverImage, { url: 'https://example.com/child-cover.jpg', publicId: 'child-cover', alt: 'Child cover' });
  assert.equal(patch.coverImageUrl, 'https://example.com/child-cover.jpg');
  assert.equal(patch.imageURL, 'https://example.com/child-cover.jpg');
  assert.equal(patch.publishedAt.toISOString(), '2026-03-29T09:00:00.000Z');
  assert.equal(patch.sourceLanguage, 'en');
});

test('buildChildNewsSyncPatch only propagates master cover media when explicitly requested', () => {
  const now = new Date('2026-03-29T12:30:00.000Z');
  const master = {
    _id: '69c832dfa5f8e74cf2bf87b7',
    title: 'Master title',
    description: 'Master summary',
    content: '<p>Master body</p>',
    lang: 'en',
    originalLang: 'en',
    status: 'published',
    publishedAt: new Date('2026-03-29T09:00:00.000Z'),
    category: 'tech',
    slugs: { en: 'master-en', hi: 'master-hi' },
    translationGroupId: 'group-1',
    coverImage: { url: 'https://example.com/master-cover.jpg', publicId: 'master-cover', alt: 'Master cover' },
    coverImageUrl: 'https://example.com/master-cover.jpg',
    imageURL: 'https://example.com/master-cover.jpg',
    translations: {
      en: { title: 'Master title', summary: 'Master summary', content: '<p>Master body</p>' },
      hi: { title: 'Hindi title', summary: 'Hindi summary', content: '<p>Hindi body</p>', generatedAt: now, provider: 'google' },
    },
    translationStatus: { en: 'ready', hi: 'ready' },
  };
  const child = {
    _id: '69c832dfa5f8e74cf2bf87ba',
    lang: 'hi',
    language: 'hi',
    originalLang: 'hi',
    coverImage: { url: 'https://example.com/child-cover.jpg', publicId: 'child-cover', alt: 'Child cover' },
    coverImageUrl: 'https://example.com/child-cover.jpg',
    imageURL: 'https://example.com/child-cover.jpg',
  };
  const metadata = prepareSourceSyncMetadata(master, { now });

  const defaultPatch = buildChildNewsSyncPatch(master, child, { now, metadata });
  assert.deepEqual(defaultPatch.coverImage, { url: 'https://example.com/child-cover.jpg', publicId: 'child-cover', alt: 'Child cover' });
  assert.equal(defaultPatch.coverImageUrl, 'https://example.com/child-cover.jpg');
  assert.equal(defaultPatch.imageURL, 'https://example.com/child-cover.jpg');

  const propagatedPatch = buildChildNewsSyncPatch(master, child, {
    now,
    metadata,
    propagateCoverMedia: true,
  });
  assert.deepEqual(propagatedPatch.coverImage, { url: 'https://example.com/master-cover.jpg', publicId: 'master-cover', alt: 'Master cover' });
  assert.equal(propagatedPatch.coverImageUrl, 'https://example.com/master-cover.jpg');
  assert.equal(propagatedPatch.imageURL, 'https://example.com/master-cover.jpg');
});