const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');
const {
  getIstTodayDateString,
  getIstDateRange,
  VIRAL_VIDEO_DAILY_PUBLISH_LIMIT,
} = require('../services/viralVideos.service');

const DATA_FILE = path.join(process.cwd(), 'data', 'viral-videos.json');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

async function readDataFileOrNull() {
  try {
    return await fs.readFile(DATA_FILE, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function buildPublishedRecord(index, publishedAt) {
  return {
    id: `fallback-published-${index}`,
    _id: `fallback-published-${index}`,
    title: `Fallback Published ${index}`,
    slug: `fallback-published-${index}`,
    thumbnailUrl: `https://img.example/fallback-${index}.jpg`,
    videoUrl: `https://cdn.example/fallback-${index}.mp4`,
    duration: '00:30',
    language: 'en',
    status: 'published',
    category: 'viral',
    source: 'News Pulse',
    isActive: true,
    publishedAt,
    createdAt: publishedAt,
    updatedAt: publishedAt,
  };
}

test('viral video admin and public routes use JSON fallback when Mongo is unavailable', async (t) => {
  const originalEnv = process.env.NODE_ENV;
  const originalData = await readDataFileOrNull();

  t.after(async () => {
    process.env.NODE_ENV = originalEnv;
    if (originalData === null) {
      await fs.rm(DATA_FILE, { force: true });
    } else {
      await fs.writeFile(DATA_FILE, originalData, 'utf8');
    }
  });

  process.env.NODE_ENV = 'development';
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, '[]\n', 'utf8');

  const token = makeOpaqueAdminToken();
  const createRes = await request(app)
    .post('/api/admin/viral-videos')
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: 'Fallback viral video',
      description: 'Created without MongoDB',
      thumbnailUrl: 'https://img.example/fallback.jpg',
      videoUrl: 'https://cdn.example/fallback.mp4',
      duration: '00:42',
      language: 'en',
      status: 'published',
    });

  assert.equal(createRes.statusCode, 201);
  assert.equal(createRes.body.success, true);
  assert.equal(createRes.body.video.category, 'viral');
  assert.equal(createRes.body.video.source, 'News Pulse');
  assert.equal(createRes.body.video.uploadedBy, 'Admin');
  assert.equal(createRes.body.video.slug, 'fallback-viral-video');

  const listRes = await request(app).get('/api/viral-videos');

  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.success, true);
  assert.equal(listRes.body.videos.length, 1);
  assert.equal(listRes.body.videos[0].slug, 'fallback-viral-video');

  const detailRes = await request(app).get('/api/viral-videos/fallback-viral-video');

  assert.equal(detailRes.statusCode, 200);
  assert.equal(detailRes.body.success, true);
  assert.equal(detailRes.body.video.title, 'Fallback viral video');
  assert.equal(detailRes.body.video.description, 'Created without MongoDB');
  assert.equal(detailRes.body.video.duration, '00:42');

  const draftRes = await request(app)
    .put(`/api/admin/viral-videos/${createRes.body.video.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'draft', title: 'Fallback viral video edited' });

  assert.equal(draftRes.statusCode, 200);
  assert.equal(draftRes.body.video.status, 'draft');
  assert.equal(draftRes.body.video.title, 'Fallback viral video edited');

  const hiddenRes = await request(app).get('/api/viral-videos');

  assert.equal(hiddenRes.statusCode, 200);
  assert.deepEqual(hiddenRes.body.videos, []);

  const publishRes = await request(app)
    .put(`/api/admin/viral-videos/${createRes.body.video.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'published' });

  assert.equal(publishRes.statusCode, 200);
  assert.equal(publishRes.body.video.status, 'published');

  const deleteRes = await request(app)
    .delete(`/api/admin/viral-videos/${createRes.body.video.id}`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(deleteRes.statusCode, 200);
  assert.equal(deleteRes.body.archived, true);
  assert.equal(deleteRes.body.video.isActive, false);
  assert.equal(deleteRes.body.video.status, 'archived');

  const afterDeleteRes = await request(app).get('/api/viral-videos');

  assert.equal(afterDeleteRes.statusCode, 200);
  assert.deepEqual(afterDeleteRes.body.videos, []);
});

test('viral video JSON fallback enforces IST daily publish limit and date filters', async (t) => {
  const originalEnv = process.env.NODE_ENV;
  const originalData = await readDataFileOrNull();

  t.after(async () => {
    process.env.NODE_ENV = originalEnv;
    if (originalData === null) {
      await fs.rm(DATA_FILE, { force: true });
    } else {
      await fs.writeFile(DATA_FILE, originalData, 'utf8');
    }
  });

  process.env.NODE_ENV = 'development';
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });

  const todayRange = getIstDateRange(getIstTodayDateString());
  const yesterdayRange = { start: new Date(todayRange.start.getTime() - 24 * 60 * 60 * 1000) };
  const todayRows = Array.from({ length: VIRAL_VIDEO_DAILY_PUBLISH_LIMIT }, (_value, index) => {
    const publishedAt = new Date(todayRange.start.getTime() + ((index + 1) * 60 * 1000)).toISOString();
    return buildPublishedRecord(index + 1, publishedAt);
  });
  const yesterdayRow = buildPublishedRecord(99, new Date(yesterdayRange.start.getTime() + 60 * 1000).toISOString());
  await fs.writeFile(DATA_FILE, `${JSON.stringify([...todayRows, yesterdayRow], null, 2)}\n`, 'utf8');

  const token = makeOpaqueAdminToken();
  const countRes = await request(app)
    .get('/api/admin/viral-videos/daily-count')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(countRes.statusCode, 200);
  assert.equal(countRes.body.date, getIstTodayDateString());
  assert.equal(countRes.body.timezone, 'Asia/Kolkata');
  assert.equal(countRes.body.publishedCount, VIRAL_VIDEO_DAILY_PUBLISH_LIMIT);
  assert.equal(countRes.body.limit, VIRAL_VIDEO_DAILY_PUBLISH_LIMIT);
  assert.equal(countRes.body.remaining, 0);

  const rejectedPublish = await request(app)
    .post('/api/admin/viral-videos')
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: 'Over limit published clip',
      thumbnailUrl: 'https://img.example/over-limit.jpg',
      videoUrl: 'https://cdn.example/over-limit.mp4',
      language: 'en',
      status: 'published',
    });

  assert.equal(rejectedPublish.statusCode, 400);
  assert.equal(rejectedPublish.body.message, 'Daily viral video limit reached. You can save this video as Draft or schedule it for tomorrow.');

  const draftRes = await request(app)
    .post('/api/admin/viral-videos')
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: 'Over limit draft clip',
      thumbnailUrl: 'https://img.example/draft.jpg',
      videoUrl: 'https://cdn.example/draft.mp4',
      language: 'en',
      status: 'draft',
    });

  assert.equal(draftRes.statusCode, 201);
  assert.equal(draftRes.body.video.status, 'draft');
  assert.equal(draftRes.body.video.showOnHomepage, false);
  assert.equal(draftRes.body.video.featured, false);

  const rejectedUpdate = await request(app)
    .put(`/api/admin/viral-videos/${draftRes.body.video.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'published' });

  assert.equal(rejectedUpdate.statusCode, 400);
  assert.equal(rejectedUpdate.body.message, 'Daily viral video limit reached. You can save this video as Draft or schedule it for tomorrow.');

  const todayPublic = await request(app).get('/api/viral-videos?date=today&limit=50');
  assert.equal(todayPublic.statusCode, 200);
  assert.equal(todayPublic.body.videos.length, VIRAL_VIDEO_DAILY_PUBLISH_LIMIT);
  assert.equal(todayPublic.body.videos.every((video) => video.status === 'published' && video.category === 'viral'), true);

  const yesterdayPublic = await request(app).get('/api/viral-videos?date=yesterday&limit=50');
  assert.equal(yesterdayPublic.statusCode, 200);
  assert.equal(yesterdayPublic.body.videos.length, 1);
  assert.equal(yesterdayPublic.body.videos[0].slug, 'fallback-published-99');

  const allPublic = await request(app).get('/api/viral-videos?period=all&limit=50');
  assert.equal(allPublic.statusCode, 200);
  assert.equal(allPublic.body.videos.length, VIRAL_VIDEO_DAILY_PUBLISH_LIMIT + 1);
});