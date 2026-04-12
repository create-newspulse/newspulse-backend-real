const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAdminDashboardStatsPayload,
  buildEmptyAdminDashboardStatsPayload,
} = require('../controllers/adminDashboardStatsController');

function buildAggregateStub(entries) {
  return async (pipeline) => {
    const serialized = JSON.stringify(pipeline || []);
    for (const entry of entries) {
      if (entry.match(serialized)) return entry.rows;
    }
    return [];
  };
}

test('buildAdminDashboardStatsPayload returns clear scoped counts for news, categories, languages, users, and AI logs', async () => {
  const now = new Date('2026-04-13T12:00:00.000Z');

  const NewsModel = {
    countDocuments: async (filter) => {
      assert.deepEqual(filter, {});
      return 20;
    },
    aggregate: buildAggregateStub([
      {
        match: (serialized) => serialized.includes('statusValue'),
        rows: [
          { _id: 'published', count: 15 },
          { _id: 'draft', count: 3 },
          { _id: 'archived', count: 1 },
          { _id: 'deleted', count: 1 },
        ],
      },
      {
        match: (serialized) => serialized.includes('"status":{"$ne":"deleted"}') && serialized.includes('$category'),
        rows: [
          { _id: 'regional', count: 8 },
          { _id: 'national', count: 4 },
          { _id: 'sports', count: 3 },
          { _id: 'tech', count: 2 },
          { _id: 'science-technology', count: 1 },
          { _id: 'business', count: 1 },
        ],
      },
      {
        match: (serialized) => serialized.includes('"status":{"$ne":"deleted"}') && (serialized.includes('$lang') || serialized.includes('$language')),
        rows: [
          { _id: 'en', count: 11 },
          { _id: 'hi', count: 6 },
          { _id: 'gu', count: 2 },
        ],
      },
    ]),
  };

  const ArticleModel = {
    countDocuments: async (filter) => {
      const serialized = JSON.stringify(filter || {});
      assert.match(serialized, /published/);
      assert.match(serialized, /publishedAt/);
      return 15;
    },
    aggregate: buildAggregateStub([
      {
        match: (serialized) => serialized.includes('publishedAt') && serialized.includes('$category'),
        rows: [
          { _id: 'regional', count: 7 },
          { _id: 'national', count: 3 },
          { _id: 'sports', count: 2 },
          { _id: 'tech', count: 2 },
          { _id: 'business', count: 1 },
        ],
      },
      {
        match: (serialized) => serialized.includes('"status":"published"') && (serialized.includes('$lang') || serialized.includes('$language')),
        rows: [
          { _id: 'en', count: 9 },
          { _id: 'hi', count: 4 },
          { _id: 'gu', count: 2 },
        ],
      },
    ]),
  };

  const UserModel = {
    countDocuments: async (filter) => {
      assert.deepEqual(filter, {
        $or: [
          { status: 'active' },
          { status: null },
          { status: { $exists: false } },
        ],
      });
      return 4;
    },
  };

  const KiranOSLogModel = {
    countDocuments: async (filter) => {
      assert.deepEqual(filter, {});
      return 12;
    },
  };

  const payload = await buildAdminDashboardStatsPayload({
    dbConnected: true,
    now,
    NewsModel,
    ArticleModel,
    UserModel,
    KiranOSLogModel,
  });

  assert.equal(payload.totalNews, 20);
  assert.equal(payload.totalNewsRecords, 20);
  assert.equal(payload.publishedNews, 15);
  assert.equal(payload.draftNews, 3);
  assert.equal(payload.archivedNews, 1);
  assert.equal(payload.latestPublicVisible, 15);
  assert.equal(payload.publicVisibleNews, 15);

  assert.equal(payload.categoriesCount, 5);
  assert.equal(payload.activeCategoriesCount, 5);
  assert.equal(payload.visibleCategoriesCount, 5);
  assert.equal(payload.configuredCategoriesCount > payload.categoriesCount, true);
  assert.deepEqual(payload.categories.items.map((item) => item.name), ['regional', 'national', 'sports', 'tech', 'business']);
  assert.deepEqual(payload.categories.active.items.map((item) => item.name), ['regional', 'national', 'sports', 'tech', 'business']);

  assert.equal(payload.languagesCount, 3);
  assert.equal(payload.configuredLanguagesCount, 3);
  assert.equal(payload.activeLanguagesCount, 3);
  assert.equal(payload.visibleLanguagesCount, 3);
  assert.deepEqual(payload.languages.items.map((item) => item.code), ['EN', 'GU', 'HI']);

  assert.equal(payload.activeUsers, 4);
  assert.equal(payload.activeUsersCount, 4);
  assert.equal(payload.aiLogs, 12);
  assert.equal(payload.aiLogsCount, 12);

  assert.equal(payload.statDefinitions.totalNews, 'All CMS News records across every status in the News collection.');
  assert.equal(payload.queryAudit.totalNews.model, 'News');
  assert.equal(payload.queryAudit.latestPublicVisible.model, 'Article');
  assert.equal(payload.queryAudit.latestPublicVisible.filterSummary.evaluatedAt, now.toISOString());
});

test('buildAdminDashboardStatsPayload falls back to empty audited payload when DB is unavailable', async () => {
  const payload = await buildAdminDashboardStatsPayload({ dbConnected: false });
  const empty = buildEmptyAdminDashboardStatsPayload();

  assert.equal(payload.totalNews, empty.totalNews);
  assert.equal(payload.categoriesCount, empty.categoriesCount);
  assert.equal(payload.languagesCount, empty.languagesCount);
  assert.equal(payload.latestPublicVisible, empty.latestPublicVisible);
  assert.equal(payload.configuredCategoriesCount, empty.configuredCategoriesCount);
  assert.equal(payload.queryAudit.totalNews.model, 'News');
});
