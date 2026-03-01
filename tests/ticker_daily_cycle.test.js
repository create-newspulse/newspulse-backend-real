const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');
const BroadcastItem = require('../models/BroadcastItem');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:${Date.now()}`).toString('base64');
  return `np.${b64}`;
}

function makeQuery(items, filter) {
  // Very small in-memory evaluator for the filters used by publicTicker routes.
  const and = Array.isArray(filter && filter.$and) ? filter.$and : [];
  const type = and.find((c) => c && typeof c === 'object' && typeof c.type === 'string')?.type;
  const dateKey = and.find((c) => c && typeof c === 'object' && typeof c.dateKey === 'string')?.dateKey;

  let out = items.slice();
  if (type) out = out.filter((i) => i.type === type);
  if (dateKey) out = out.filter((i) => i.dateKey === dateKey);
  out = out.filter((i) => i.isLive === true);
  out = out.filter((i) => i.isActive !== false);

  const q = {
    _sort: null,
    _limit: null,
    sort(s) {
      this._sort = s;
      return this;
    },
    limit(n) {
      this._limit = n;
      return this;
    },
    lean() {
      return this;
    },
    async then(resolve, reject) {
      try {
        let res = out.slice();
        const s = this._sort || {};
        const keys = Object.keys(s);
        if (keys.length) {
          res.sort((a, b) => {
            for (const k of keys) {
              const dir = s[k];
              const av = a[k];
              const bv = b[k];
              if (av === bv) continue;
              if (av === undefined || av === null) return 1;
              if (bv === undefined || bv === null) return -1;
              if (av < bv) return dir < 0 ? 1 : -1;
              if (av > bv) return dir < 0 ? -1 : 1;
            }
            return 0;
          });
        }
        if (typeof this._limit === 'number') res = res.slice(0, this._limit);
        return resolve(res);
      } catch (e) {
        return reject(e);
      }
    },
  };

  return q;
}

test('Ticker APIs: admin create -> public read (IST dateKey + sorting)', async () => {
  const prevReady = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  const token = makeOpaqueAdminToken();

  const items = [];
  const docsById = new Map();

  const realCreate = BroadcastItem.create;
  const realFind = BroadcastItem.find;
  const realFindById = BroadcastItem.findById;
  const realFindByIdAndUpdate = BroadcastItem.findByIdAndUpdate;

  BroadcastItem.create = async (payload) => {
    const id = new mongoose.Types.ObjectId().toString();
    const doc = {
      _id: id,
      ...payload,
      set(k, v) { this[k] = v; },
      save: async () => doc,
    };
    items.push(doc);
    docsById.set(id, doc);
    return doc;
  };

  BroadcastItem.find = (filter) => makeQuery(items, filter);

  BroadcastItem.findById = async (id) => docsById.get(String(id)) || null;

  BroadcastItem.findByIdAndUpdate = async (id, update) => {
    const doc = docsById.get(String(id));
    if (!doc) return null;
    const set = update && update.$set ? update.$set : {};
    for (const [k, v] of Object.entries(set)) doc[k] = v;
    return doc;
  };

  // Create 2 live items with different pin/priority ordering.
  const create1 = await request(app)
    .post('/api/admin/ticker')
    .set('Authorization', `Bearer ${token}`)
    .send({ type: 'live', text: 'Item A', lang: 'en', isPinned: false, priority: 1, autoTranslate: false })
    .expect(201);

  const create2 = await request(app)
    .post('/api/admin/ticker')
    .set('Authorization', `Bearer ${token}`)
    .send({ type: 'live', text: 'Item B', lang: 'en', isPinned: true, priority: 0, autoTranslate: false })
    .expect(201);

  assert.equal(create1.body.ok, true);
  assert.equal(create2.body.ok, true);

  const dateKey = create1.body.item.dateKey;
  assert.ok(typeof dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateKey));

  // Public API returns pinned first.
  const pub = await request(app)
    .get(`/api/ticker/live/all?date=${encodeURIComponent(dateKey)}&lang=en`)
    .expect(200);

  assert.equal(pub.body.ok, true);
  assert.equal(pub.body.dateKey, dateKey);
  assert.equal(pub.body.items.length, 2);
  assert.equal(pub.body.items[0].text, 'Item B');
  assert.equal(pub.body.items[1].text, 'Item A');

  // Soft-delete the pinned item.
  const del = await request(app)
    .delete(`/api/admin/ticker/${create2.body.item.id}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  assert.equal(del.body.ok, true);

  const pub2 = await request(app)
    .get(`/api/ticker/live/all?date=${encodeURIComponent(dateKey)}&lang=en`)
    .expect(200);

  assert.equal(pub2.body.items.length, 1);
  assert.equal(pub2.body.items[0].text, 'Item A');

  // Restore
  BroadcastItem.create = realCreate;
  BroadcastItem.find = realFind;
  BroadcastItem.findById = realFindById;
  BroadcastItem.findByIdAndUpdate = realFindByIdAndUpdate;
  mongoose.connection.readyState = prevReady;
});
