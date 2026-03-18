const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');
const TickerAd = require('../models/TickerAd');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:${Date.now()}`).toString('base64');
  return `np.${b64}`;
}

function makeQuery(store, filter) {
  const queryFilter = filter && typeof filter === 'object' ? filter : {};

  let items = store.slice();

  const matchesOps = (value, ops) => {
    if (!ops || typeof ops !== 'object' || Array.isArray(ops)) return value === ops;
    if (Object.prototype.hasOwnProperty.call(ops, '$exists')) {
      const shouldExist = Boolean(ops.$exists);
      const exists = value !== undefined;
      if (exists !== shouldExist) return false;
    }
    if (Object.prototype.hasOwnProperty.call(ops, '$size')) {
      if (!Array.isArray(value)) return false;
      if (value.length !== ops.$size) return false;
    }
    if (Object.prototype.hasOwnProperty.call(ops, '$in')) {
      const list = Array.isArray(ops.$in) ? ops.$in : [];
      if (Array.isArray(value)) return value.some((entry) => list.includes(entry));
      return list.includes(value);
    }
    if (Object.prototype.hasOwnProperty.call(ops, '$lte')) {
      if (!(value <= ops.$lte)) return false;
    }
    if (Object.prototype.hasOwnProperty.call(ops, '$lt')) {
      if (!(value < ops.$lt)) return false;
    }
    if (Object.prototype.hasOwnProperty.call(ops, '$gte')) {
      if (!(value >= ops.$gte)) return false;
    }
    if (Object.prototype.hasOwnProperty.call(ops, '$gt')) {
      if (!(value > ops.$gt)) return false;
    }
    return true;
  };

  items = items.filter((item) => {
    const entries = Object.entries(queryFilter);

    // Handle top-level $or with AND semantics against other fields.
    const orClause = queryFilter.$or;
    if (Array.isArray(orClause)) {
      const passesOr = orClause.some((clause) => {
        if (!clause || typeof clause !== 'object') return false;
        for (const [key, expected] of Object.entries(clause)) {
          if (!matchesOps(item[key], expected)) return false;
        }
        return true;
      });
      if (!passesOr) return false;
    }

    for (const [key, expected] of entries) {
      if (key === '$or') continue;
      if (!matchesOps(item[key], expected)) return false;
    }

    return true;
  });

  const chain = {
    _sort: null,
    sort(spec) {
      this._sort = spec;
      return this;
    },
    lean() {
      return this;
    },
    async then(resolve, reject) {
      try {
        let result = items.slice();
        const sortSpec = this._sort || {};
        const keys = Object.keys(sortSpec);
        if (keys.length > 0) {
          result.sort((left, right) => {
            for (const key of keys) {
              const dir = sortSpec[key];
              const a = left[key];
              const b = right[key];
              if (a === b) continue;
              if (a === undefined || a === null) return 1;
              if (b === undefined || b === null) return -1;
              if (a < b) return dir < 0 ? 1 : -1;
              if (a > b) return dir < 0 ? -1 : 1;
            }
            return 0;
          });
        }
        return resolve(result.map((doc) => doc.toObject()));
      } catch (error) {
        return reject(error);
      }
    },
  };

  return chain;
}

function withFixedNow(isoString, fn) {
  const RealDate = Date;
  const fixed = new RealDate(isoString);

  global.Date = class FakeDate extends RealDate {
    constructor(value) {
      if (arguments.length === 0) {
        super(fixed.getTime());
        return;
      }
      super(value);
    }

    static now() {
      return fixed.getTime();
    }

    static parse(value) {
      return RealDate.parse(value);
    }

    static UTC(...args) {
      return RealDate.UTC(...args);
    }
  };

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.Date = RealDate;
    });
}

test('Ticker Ads admin routes require auth', async () => {
  const endpoints = [
    { method: 'get', path: '/api/broadcast/ticker-ads' },
    { method: 'post', path: '/api/broadcast/ticker-ads' },
    { method: 'patch', path: '/api/broadcast/ticker-ads/64b64c2f2f2f2f2f2f2f2f2f' },
    { method: 'delete', path: '/api/broadcast/ticker-ads/64b64c2f2f2f2f2f2f2f2f2f' },
  ];

  for (const endpoint of endpoints) {
    const res = await request(app)[endpoint.method](endpoint.path).set('Content-Type', 'application/json');
    assert.equal(res.status, 401);
  }
});

test('Ticker Ads admin CRUD and public active filtering work by lang/channel/dayPart', async () => {
  const previousReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  const docs = new Map();
  const token = makeOpaqueAdminToken();

  const originalCreate = TickerAd.create;
  const originalFind = TickerAd.find;
  const originalFindById = TickerAd.findById;
  const originalFindByIdAndDelete = TickerAd.findByIdAndDelete;

  function upsert(doc) {
    docs.set(String(doc._id), doc);
    return doc;
  }

  function listDocs() {
    return Array.from(docs.values());
  }

  TickerAd.create = async (payload) => {
    const doc = new TickerAd(payload);
    doc.createdAt = new Date();
    doc.updatedAt = new Date();
    doc.save = async function saveStub() {
      await this.validate();
      if (!this.createdAt) this.createdAt = new Date();
      this.updatedAt = new Date();
      upsert(this);
      return this;
    };
    await doc.save();
    return doc;
  };

  TickerAd.find = (filter) => makeQuery(listDocs(), filter);

  TickerAd.findById = async (id) => docs.get(String(id)) || null;

  TickerAd.findByIdAndDelete = async (id) => {
    const existing = docs.get(String(id)) || null;
    if (existing) docs.delete(String(id));
    return existing;
  };

  try {
    await withFixedNow('2026-03-18T01:30:00.000Z', async () => {
      const createLive = await request(app)
        .post('/api/broadcast/ticker-ads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          message: ' <b>Live</b>   promo ',
          url: 'https://example.com/live',
          lang: 'English',
          channel: 'live',
          startAt: '2026-03-18T00:00:00.000Z',
          endAt: '2026-03-19T00:00:00.000Z',
          dayParts: ['morning'],
          priority: 2,
          frequency: 22,
        })
        .expect(201);

      assert.equal(createLive.body.item.message, 'Live promo');
      assert.equal(createLive.body.item.frequency, 10);
  assert.equal(createLive.body.item.lang, 'en');

      const createAllDay = await request(app)
        .post('/api/broadcast/ticker-ads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          message: 'All day breaking sponsor',
          url: 'https://example.com/allday',
          lang: 'en',
          channel: 'breaking',
          startAt: '2026-03-18T00:00:00.000Z',
          endAt: '2026-03-19T00:00:00.000Z',
          dayParts: [],
          priority: 1,
        })
        .expect(201);

      assert.deepEqual(createAllDay.body.item.dayParts, ['morning', 'noon', 'evening', 'night']);

      await request(app)
        .post('/api/broadcast/ticker-ads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          message: 'Both channel sponsor',
          url: 'https://example.com/both',
          lang: 'en',
          channel: 'both',
          startAt: '2026-03-18T00:00:00.000Z',
          endAt: '2026-03-19T00:00:00.000Z',
          dayParts: ['morning'],
          priority: 9,
          frequency: 2,
        })
        .expect(201);

      await request(app)
        .post('/api/broadcast/ticker-ads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          message: 'Hindi only',
          lang: 'hi',
          channel: 'live',
          startAt: '2026-03-18T00:00:00.000Z',
          endAt: '2026-03-19T00:00:00.000Z',
          dayParts: ['morning'],
          priority: 5,
        })
        .expect(201);

      await request(app)
        .post('/api/broadcast/ticker-ads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          message: 'All languages sponsor',
          lang: 'All Languages',
          messages: {
            en: 'All languages sponsor (EN)',
            hi: 'सभी भाषाएँ प्रायोजक (HI)',
            gu: 'બધી ભાષાઓ પ્રાયોજક (GU)',
          },
          channel: 'live',
          startAt: '2026-03-18T00:00:00.000Z',
          endAt: '2026-03-19T00:00:00.000Z',
          dayParts: ['morning'],
          priority: 0,
        })
        .expect(201);

      const list = await request(app)
        .get('/api/broadcast/ticker-ads?lang=English&channel=live&active=true&dateFrom=2026-03-18T00:00:00.000Z&dateTo=2026-03-18T23:59:59.000Z')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      assert.equal(list.body.success, true);
      assert.equal(list.body.items.length, 1);
      assert.equal(list.body.items[0].channel, 'live');

      const patch = await request(app)
        .patch(`/api/broadcast/ticker-ads/${createLive.body.item.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          message: '<i>Updated</i> live promo',
          frequency: 0,
          dayParts: ['morning', 'evening'],
        })
        .expect(200);

      assert.equal(patch.body.item.message, 'Updated live promo');
      assert.equal(patch.body.item.frequency, 1);

      const patchAllDay = await request(app)
        .patch(`/api/broadcast/ticker-ads/${createAllDay.body.item.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          dayParts: [],
        })
        .expect(200);

      assert.deepEqual(patchAllDay.body.item.dayParts, ['morning', 'noon', 'evening', 'night']);

      const active = await request(app)
        .get('/api/public/ticker-ads/active?lang=English&channel=live')
        .expect(200);

      assert.equal(active.body.success, true);
      assert.equal(active.body.items.length, 3);
      assert.equal(active.body.items[0].message, 'Both channel sponsor');
      assert.equal(active.body.items[1].message, 'Updated live promo');
      assert.equal(active.body.items[2].message, 'All languages sponsor (EN)');

      const activeHindi = await request(app)
        .get('/api/public/ticker-ads/active?lang=hi&channel=live')
        .expect(200);

      assert.equal(activeHindi.body.success, true);
      assert.ok(activeHindi.body.items.some((item) => item && item.message === 'Hindi only'));
      assert.ok(activeHindi.body.items.some((item) => item && item.message === 'सभी भाषाएँ प्रायोजक (HI)'));
      assert.ok(!activeHindi.body.items.some((item) => item && item.message === 'Both channel sponsor'));

      const activeGujarati = await request(app)
        .get('/api/public/ticker-ads/active?lang=gu&channel=live')
        .expect(200);

      assert.equal(activeGujarati.body.success, true);
      assert.ok(activeGujarati.body.items.some((item) => item && item.message === 'બધી ભાષાઓ પ્રાયોજક (GU)'));

      await request(app)
        .delete(`/api/broadcast/ticker-ads/${createLive.body.item.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const activeAfterDelete = await request(app)
        .get('/api/public/ticker-ads/active?lang=English&channel=live')
        .expect(200);

      assert.equal(activeAfterDelete.body.items.length, 2);
      assert.equal(activeAfterDelete.body.items[0].message, 'Both channel sponsor');
      assert.equal(activeAfterDelete.body.items[1].message, 'All languages sponsor (EN)');
    });
  } finally {
    TickerAd.create = originalCreate;
    TickerAd.find = originalFind;
    TickerAd.findById = originalFindById;
    TickerAd.findByIdAndDelete = originalFindByIdAndDelete;
    mongoose.connection.readyState = previousReadyState;
  }
});

test('Ticker Ads public active uses IST logic for date-only schedules', async () => {
  const previousReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  const docs = new Map();
  const token = makeOpaqueAdminToken();

  const originalCreate = TickerAd.create;
  const originalFind = TickerAd.find;

  function upsert(doc) {
    docs.set(String(doc._id), doc);
    return doc;
  }

  function listDocs() {
    return Array.from(docs.values());
  }

  TickerAd.create = async (payload) => {
    const doc = new TickerAd(payload);
    doc.createdAt = new Date();
    doc.updatedAt = new Date();
    doc.save = async function saveStub() {
      await this.validate();
      if (!this.createdAt) this.createdAt = new Date();
      this.updatedAt = new Date();
      upsert(this);
      return this;
    };
    await doc.save();
    return doc;
  };

  TickerAd.find = (filter) => makeQuery(listDocs(), filter);

  try {
    // 2026-03-17T20:00Z == 2026-03-18T01:30 in Asia/Kolkata (night)
    await withFixedNow('2026-03-17T20:00:00.000Z', async () => {
      await request(app)
        .post('/api/broadcast/ticker-ads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          message: 'Gujarati night sponsor',
          url: 'https://example.com/gu',
          lang: 'Gujarati',
          channel: 'live',
          // Date-only inputs should be interpreted as IST wall-clock.
          startAt: '2026-03-18',
          endAt: '2026-03-19',
          dayParts: [],
          priority: 1,
        })
        .expect(201);

      const active = await request(app)
        .get('/api/public/ticker-ads/active?lang=gu&channel=live')
        .expect(200);

      assert.equal(active.body.success, true);
      assert.ok(Array.isArray(active.body.items));
      assert.equal(active.body.items.length, 1);
      assert.equal(active.body.items[0].message, 'Gujarati night sponsor');
    });
  } finally {
    TickerAd.create = originalCreate;
    TickerAd.find = originalFind;
    mongoose.connection.readyState = previousReadyState;
  }
});

test('Ticker Ads public resolved message falls back when requested language message missing', async () => {
  const previousReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;

  const docs = new Map();
  const token = makeOpaqueAdminToken();

  const originalCreate = TickerAd.create;
  const originalFind = TickerAd.find;

  function upsert(doc) {
    docs.set(String(doc._id), doc);
    return doc;
  }

  function listDocs() {
    return Array.from(docs.values());
  }

  TickerAd.create = async (payload) => {
    const doc = new TickerAd(payload);
    doc.createdAt = new Date();
    doc.updatedAt = new Date();
    doc.save = async function saveStub() {
      await this.validate();
      if (!this.createdAt) this.createdAt = new Date();
      this.updatedAt = new Date();
      upsert(this);
      return this;
    };
    await doc.save();
    return doc;
  };

  TickerAd.find = (filter) => makeQuery(listDocs(), filter);

  try {
    await withFixedNow('2026-03-18T01:30:00.000Z', async () => {
      // Case 1: requestedLang missing, but legacy message exists -> use legacy.
      await request(app)
        .post('/api/broadcast/ticker-ads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          message: 'Legacy fallback message',
          lang: 'all',
          messages: { en: 'EN msg only', hi: '', gu: '' },
          channel: 'live',
          startAt: '2026-03-18T00:00:00.000Z',
          endAt: '2026-03-19T00:00:00.000Z',
          dayParts: ['morning'],
          priority: 0,
        })
        .expect(201);

      const activeHi = await request(app)
        .get('/api/public/ticker-ads/active?lang=hi&channel=live')
        .expect(200);

      assert.equal(activeHi.body.success, true);
      assert.ok(activeHi.body.items.some((item) => item && item.message === 'Legacy fallback message'));

      // Case 2: requestedLang missing, no legacy message -> use first available localized (en then hi then gu).
      await request(app)
        .post('/api/broadcast/ticker-ads')
        .set('Authorization', `Bearer ${token}`)
        .send({
          message: '',
          lang: 'all',
          messages: { en: 'EN fallback', hi: '', gu: 'GU fallback' },
          channel: 'live',
          startAt: '2026-03-18T00:00:00.000Z',
          endAt: '2026-03-19T00:00:00.000Z',
          dayParts: ['morning'],
          priority: 0,
        })
        .expect(201);

      const activeHi2 = await request(app)
        .get('/api/public/ticker-ads/active?lang=hi&channel=live')
        .expect(200);

      assert.equal(activeHi2.body.success, true);
      assert.ok(activeHi2.body.items.some((item) => item && item.message === 'EN fallback'));
    });
  } finally {
    TickerAd.create = originalCreate;
    TickerAd.find = originalFind;
    mongoose.connection.readyState = previousReadyState;
  }
});