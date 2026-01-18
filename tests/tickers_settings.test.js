const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';
process.env.UI_PREVIEW_SECRET = process.env.UI_PREVIEW_SECRET || 'local-test-preview-secret';

const app = require('../server');
const SiteSetting = require('../models/SiteSetting');

const VALID_CONFIG = {
  tickers: {
    live: {
      enabled: true,
      speedSec: 20,
      refreshSec: 60,
      maxItems: 10,
      showOn: ['home'],
      placeholder: 'Live',
    },
    breaking: {
      mode: 'auto',
      showWhenEmpty: false,
      speedSec: 18,
      freshnessMinutes: 120,
      maxItems: 10,
      placeholder: 'Breaking',
    },
  },
};

// In-memory settings store
let draft = null;
let published = []; // newest last

function resetStore() {
  draft = null;
  published = [];
}

function patchModel() {
  // findOne with minimal chain support (sort)
  SiteSetting.findOne = (filter) => {
    const api = {
      _sort: null,
      sort(s) {
        this._sort = s;
        return this;
      },
      async then(resolve, reject) {
        try {
          const status = filter.status;
          if (status === 'draft') return resolve(draft);
          if (status === 'published') {
            if (!published.length) return resolve(null);
            // always return latest version
            return resolve(published[published.length - 1]);
          }
          return resolve(null);
        } catch (e) {
          return reject(e);
        }
      },
    };
    return api;
  };

  SiteSetting.findOneAndUpdate = async (_filter, update, _opts) => {
    const set = update.$set || {};
    draft = {
      _id: { toString: () => 'draft-1' },
      scope: set.scope,
      key: set.key,
      status: 'draft',
      data: set.data,
      createdBy: set.createdBy,
      updatedAt: new Date(),
      createdAt: draft?.createdAt || new Date(),
    };
    return draft;
  };

  SiteSetting.create = async (payload) => {
    const doc = {
      _id: { toString: () => `pub-${payload.version}` },
      ...payload,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    published.push(doc);
    return doc;
  };

  SiteSetting.find = (_filter) => {
    const api = {
      sort() { return this; },
      limit() { return this; },
      async then(resolve, reject) {
        try {
          // Return newest-first list
          return resolve(published.slice().reverse());
        } catch (e) {
          return reject(e);
        }
      },
    };
    return api;
  };
}

patchModel();

test('Public tickers settings returns default when no published', async () => {
  resetStore();
  const prev = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  const res = await request(app).get('/public/settings/tickers');
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.success);
  assert.ok(res.body.data && res.body.data.tickers);
  assert.strictEqual(res.body.source, 'default');
  {
    const cc = String(res.headers['cache-control'] || '');
    assert.ok(cc.includes('no-store'));
    assert.ok(cc.includes('no-cache'));
  }

  // Default values should match the product defaults
  assert.strictEqual(res.body.data.tickers.live.speedSec, 24);
  assert.strictEqual(res.body.data.tickers.live.refreshSec, 30);
  assert.strictEqual(res.body.data.tickers.live.maxItems, 20);
  assert.strictEqual(res.body.data.tickers.breaking.showWhenEmpty, true);

  mongoose.connection.readyState = prev;
});

test('Admin draft save + publish creates published v1', async () => {
  resetStore();
  const prev = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  const saveDraft = await request(app)
    .put('/admin/settings/tickers/draft')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send(VALID_CONFIG);
  assert.strictEqual(saveDraft.statusCode, 200);
  assert.ok(saveDraft.body.success);
  assert.strictEqual(saveDraft.body.setting.status, 'draft');

  const publishRes = await request(app)
    .post('/admin/settings/tickers/publish')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();
  assert.strictEqual(publishRes.statusCode, 200);
  assert.ok(publishRes.body.success);
  assert.strictEqual(publishRes.body.setting.status, 'published');
  assert.strictEqual(publishRes.body.setting.version, 1);

  // Public now returns published
  const pub = await request(app).get('/public/settings/tickers');
  assert.strictEqual(pub.statusCode, 200);
  assert.ok(pub.body.success);
  assert.strictEqual(pub.body.source, 'published');
  assert.strictEqual(pub.body.data.tickers.live.speedSec, 20);

  mongoose.connection.readyState = prev;
});

test('GET /api/admin/tickers/draft returns 200 (path form)', async () => {
  const res = await request(app)
    .get('/api/admin/tickers/draft')
    .set('Cookie', 'np_admin=admin@newspulse.ai');

  assert.strictEqual(res.status, 200);
  assert.ok(res.body && res.body.ok === true);
});

test('GET /api/admin/public-settings/tickers?status=draft returns 200', async () => {
  const res = await request(app)
    .get('/api/admin/public-settings/tickers?status=draft')
    .set('Cookie', 'np_admin=admin@newspulse.ai');

  assert.strictEqual(res.status, 200);
  assert.ok(res.body && res.body.ok === true);
});

test('Preview token allows returning draft via public endpoint', async () => {
  resetStore();
  const prev = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  // draft differs from published
  const draftConfig = JSON.parse(JSON.stringify(VALID_CONFIG));
  draftConfig.tickers.live.speedSec = 25;

  await request(app)
    .put('/admin/settings/tickers/draft')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send(draftConfig);

  await request(app)
    .post('/admin/settings/tickers/publish')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();

  // Update draft after publish
  draftConfig.tickers.live.speedSec = 30;
  await request(app)
    .put('/admin/settings/tickers/draft')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send(draftConfig);

  const tokenRes = await request(app)
    .post('/admin/settings/tickers/preview-token')
    .set('Cookie', 'np_admin=admin@newspulse.ai')
    .send();
  assert.strictEqual(tokenRes.statusCode, 200);
  assert.ok(tokenRes.body.token);

  const previewRes = await request(app)
    .get(`/public/settings/tickers?preview=${encodeURIComponent(tokenRes.body.token)}`);
  assert.strictEqual(previewRes.statusCode, 200);
  assert.ok(previewRes.body.success);
  assert.strictEqual(previewRes.body.source, 'draft');
  assert.strictEqual(previewRes.body.data.tickers.live.speedSec, 30);
  {
    const cc = String(previewRes.headers['cache-control'] || '');
    assert.ok(cc.includes('no-store'));
    assert.ok(cc.includes('no-cache'));
  }

  // Invalid token returns 401
  const bad = await request(app).get('/public/settings/tickers?preview=badtoken');
  assert.strictEqual(bad.statusCode, 401);

  mongoose.connection.readyState = prev;
});
