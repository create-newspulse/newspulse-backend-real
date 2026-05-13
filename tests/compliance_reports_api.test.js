const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

const ComplianceReport = require('../models/ComplianceReport');
const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function createQueryResult(value) {
  return {
    collation() {
      return this;
    },
    lean: async () => value,
  };
}

test('compliance reports admin CRUD and public listing contract', async (t) => {
  const prevReadyState = mongoose.connection.readyState;
  const prevCountDocuments = ComplianceReport.countDocuments;
  const prevFindOneAndUpdate = ComplianceReport.findOneAndUpdate;
  const prevFind = ComplianceReport.find;
  const prevFindOne = ComplianceReport.findOne;
  const prevCreate = ComplianceReport.create;
  const prevFindByIdAndUpdate = ComplianceReport.findByIdAndUpdate;
  const prevFindByIdAndDelete = ComplianceReport.findByIdAndDelete;

  const seedId = '507f191e810c19729de860aa';
  const createdId = '507f191e810c19729de860ab';
  const storage = [];

  t.after(() => {
    mongoose.connection.readyState = prevReadyState;
    ComplianceReport.countDocuments = prevCountDocuments;
    ComplianceReport.findOneAndUpdate = prevFindOneAndUpdate;
    ComplianceReport.find = prevFind;
    ComplianceReport.findOne = prevFindOne;
    ComplianceReport.create = prevCreate;
    ComplianceReport.findByIdAndUpdate = prevFindByIdAndUpdate;
    ComplianceReport.findByIdAndDelete = prevFindByIdAndDelete;
  });

  mongoose.connection.readyState = 1;

  ComplianceReport.countDocuments = async () => storage.length;

  ComplianceReport.findOneAndUpdate = async (filter, update) => {
    let doc = storage.find((entry) => entry.month.toLowerCase() === String(filter.month || '').toLowerCase() && entry.year === filter.year) || null;
    if (!doc && update && update.$setOnInsert) {
      doc = {
        _id: seedId,
        ...update.$setOnInsert,
        createdAt: '2026-05-12T00:00:00.000Z',
        updatedAt: '2026-05-12T00:00:00.000Z',
      };
      storage.push(doc);
    }
    return doc;
  };

  ComplianceReport.find = (filter = {}) => {
    const rows = storage.filter((entry) => {
      if (filter.status && entry.status !== filter.status) return false;
      return true;
    });
    return createQueryResult(rows.map((entry) => ({ ...entry })));
  };

  ComplianceReport.findOne = (filter = {}) => {
    const row = storage.find((entry) => {
      if (filter.year !== undefined && entry.year !== filter.year) return false;
      if (filter.month !== undefined && entry.month.toLowerCase() !== String(filter.month).toLowerCase()) return false;
      if (filter._id && filter._id.$ne && entry._id === filter._id.$ne) return false;
      return true;
    }) || null;
    return createQueryResult(row ? { ...row } : null);
  };

  ComplianceReport.create = async (payload) => {
    const doc = {
      _id: createdId,
      ...payload,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    };
    storage.push(doc);
    return {
      toObject() {
        return { ...doc };
      },
    };
  };

  ComplianceReport.findByIdAndUpdate = (id, update) => createQueryResult((() => {
    const index = storage.findIndex((entry) => entry._id === id);
    if (index === -1) return null;
    storage[index] = {
      ...storage[index],
      ...update.$set,
      updatedAt: '2026-06-15T00:00:00.000Z',
    };
    return { ...storage[index] };
  })());

  ComplianceReport.findByIdAndDelete = (id) => createQueryResult((() => {
    const index = storage.findIndex((entry) => entry._id === id);
    if (index === -1) return null;
    const [removed] = storage.splice(index, 1);
    return { ...removed };
  })());

  const token = makeOpaqueAdminToken();

  const publicSeedRes = await request(app).get('/api/public/compliance-reports');
  assert.equal(publicSeedRes.status, 200);
  assert.equal(publicSeedRes.body.ok, true);
  assert.equal(publicSeedRes.body.items.length, 1);
  assert.equal(publicSeedRes.body.items[0].label, 'April 2026');
  assert.equal(publicSeedRes.body.items[0].grievancesReceived, 0);
  assert.equal(publicSeedRes.body.items[0].complaintsReceived, 0);

  const adminGetRes = await request(app)
    .get('/api/admin/compliance-reports')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(adminGetRes.status, 200);
  assert.equal(adminGetRes.body.ok, true);
  assert.equal(adminGetRes.body.items.length, 1);

  const adminProxyGetRes = await request(app)
    .get('/admin-api/api/admin/compliance-reports')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(adminProxyGetRes.status, 200);
  assert.equal(adminProxyGetRes.body.ok, true);
  assert.equal(adminProxyGetRes.body.items.length, 1);

  const invalidCreateRes = await request(app)
    .post('/api/admin/compliance-reports')
    .set('Authorization', `Bearer ${token}`)
    .send({
      month: 'May',
      year: 2026,
      label: 'May 2026',
      grievancesReceived: -1,
      grievancesResolved: 0,
      grievancesPending: 0,
      averageResponseTime: 'Nil',
      actionTakenOnOrders: 'Nil',
      note: 'None',
      status: 'Published',
    });

  assert.equal(invalidCreateRes.status, 400);
  assert.equal(invalidCreateRes.body.ok, false);

  const createRes = await request(app)
    .post('/api/admin/compliance-reports')
    .set('Authorization', `Bearer ${token}`)
    .send({
      month: 'May',
      year: 2026,
      label: 'May 2026',
      publishedDate: '10 June 2026',
      grievancesReceived: 1,
      grievancesResolved: 1,
      averageResponseTime: '1 day',
      grievancesPending: 0,
      actionTakenOnOrders: 'Nil',
      note: 'One complaint resolved.',
      status: 'Draft',
    });

  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.ok, true);
  assert.equal(createRes.body.item.createdBy, 'admin@newspulse.ai');
  assert.equal(createRes.body.item.grievancesReceived, 1);
  assert.equal(createRes.body.item.complaintsReceived, 1);

  const duplicateCreateRes = await request(app)
    .post('/api/admin/compliance-reports')
    .set('Authorization', `Bearer ${token}`)
    .send({
      month: 'may',
      year: 2026,
      label: 'May 2026 duplicate',
      complaintsReceived: 0,
      complaintsResolved: 0,
      averageResponseTime: 'Nil',
      complaintsPending: 0,
      actionTakenOnOrders: 'Nil',
      note: 'Duplicate',
      status: 'Draft',
    });

  assert.equal(duplicateCreateRes.status, 409);

  const publicPublishedOnlyRes = await request(app).get('/api/public/compliance-reports');
  assert.equal(publicPublishedOnlyRes.status, 200);
  assert.equal(publicPublishedOnlyRes.body.items.length, 1);
  assert.equal(publicPublishedOnlyRes.body.items[0].label, 'April 2026');

  const updateRes = await request(app)
    .put(`/api/admin/compliance-reports/${createdId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      month: 'May',
      year: 2026,
      label: 'May 2026',
      publishedDate: '10 June 2026',
      complaintsReceived: 1,
      complaintsResolved: 1,
      averageResponseTime: '1 day',
      grievancesPending: 0,
      actionTakenOnOrders: 'Nil',
      note: 'One complaint resolved.',
      status: 'Published',
    });

  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.ok, true);
  assert.equal(updateRes.body.item.updatedBy, 'admin@newspulse.ai');
  assert.equal(updateRes.body.item.grievancesPending, 0);

  const publicSortedRes = await request(app).get('/api/public/compliance-reports');
  assert.equal(publicSortedRes.status, 200);
  assert.deepEqual(
    publicSortedRes.body.items.map((entry) => entry.label),
    ['May 2026', 'April 2026'],
  );

  const deleteRes = await request(app)
    .delete(`/api/admin/compliance-reports/${createdId}`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.body.ok, true);
  assert.equal(deleteRes.body.item._id, createdId);
});

test('GET /api/admin/compliance-reports is protected', async () => {
  const res = await request(app).get('/api/admin/compliance-reports');
  assert.equal(res.status, 401);
});