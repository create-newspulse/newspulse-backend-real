const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';

const app = require('../server');
const CommunitySubmission = require('../models/CommunitySubmission');
const News = require('../models/News');
const Article = require('../models/Article');
const ReporterStoryLink = require('../models/ReporterStoryLink');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

function makeToken(role) {
  return jwt.sign(
    { sub: '507f1f77bcf86cd799439011', email: 'admin@newspulse.ai', role, tokenVersion: 0, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function forceMongoReady() {
  const original = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  return () => { mongoose.connection.readyState = original; };
}

function stubUserLookups() {
  const originalFindById = User.findById;
  const originalFindOne = User.findOne;

  User.findById = () => ({ lean: () => Promise.resolve(null) });
  User.findOne = () => ({ lean: () => Promise.resolve(null) });

  return () => {
    User.findById = originalFindById;
    User.findOne = originalFindOne;
  };
}

function stubAuditCreate() {
  const originalCreate = AuditLog.create;
  AuditLog.create = () => Promise.resolve({ _id: '000000000000000000000000' });
  return () => { AuditLog.create = originalCreate; };
}

test('Community Story Desk: soft delete marks story as deleted', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('admin');
  const id = '507f1f77bcf86cd799439011';

  const originalFindById = CommunitySubmission.findById;
  const originalUpdateOne = CommunitySubmission.updateOne;

  const calls = { update: [] };

  try {
    CommunitySubmission.findById = () => ({
      lean: () => Promise.resolve({
        _id: id,
        sourceType: 'community',
        status: 'APPROVED',
        isDeleted: false,
        reporterEmail: 'ravi@example.com',
      }),
    });

    CommunitySubmission.updateOne = (filter, update) => {
      calls.update.push({ filter, update });
      return Promise.resolve({ modifiedCount: 1 });
    };

    const res = await request(app)
      .delete(`/admin-api/admin/community/my-stories/${id}`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.action, 'soft_delete');

    assert.equal(calls.update.length, 1);
    const upd = calls.update[0].update;
    assert.equal(upd.$set.isDeleted, true);
    assert.equal(upd.$set.status, 'DELETED');
    assert.equal(upd.$set.previousStatus, 'APPROVED');
    assert.ok(upd.$set.deletedAt);
    assert.ok(upd.$set.deletedBy);
  } finally {
    CommunitySubmission.findById = originalFindById;
    CommunitySubmission.updateOne = originalUpdateOne;
    restoreAudit();
    restoreUser();
    restoreMongo();
  }
});

test('Community Story Desk: soft delete alias works for /admin/community-reporter/submissions/:id/soft-delete', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('admin');
  const id = '507f1f77bcf86cd799439111';

  const originalFindById = CommunitySubmission.findById;
  const originalUpdateOne = CommunitySubmission.updateOne;

  const calls = { update: [] };

  try {
    CommunitySubmission.findById = () => ({
      lean: () => Promise.resolve({
        _id: id,
        sourceType: 'community',
        status: 'NEW',
        isDeleted: false,
        reporterEmail: 'ravi@example.com',
      }),
    });

    CommunitySubmission.updateOne = (filter, update) => {
      calls.update.push({ filter, update });
      return Promise.resolve({ modifiedCount: 1 });
    };

    const res = await request(app)
      .post(`/admin-api/admin/community-reporter/submissions/${id}/soft-delete`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.action, 'soft_delete');

    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].update.$set.status, 'DELETED');
    assert.equal(calls.update[0].update.$set.isDeleted, true);
  } finally {
    CommunitySubmission.findById = originalFindById;
    CommunitySubmission.updateOne = originalUpdateOne;
    restoreAudit();
    restoreUser();
    restoreMongo();
  }
});

test('Community Story Desk: trash alias works for /admin/community-reporter/submissions/:id/trash', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('admin');
  const id = '507f1f77bcf86cd799439113';

  const originalFindById = CommunitySubmission.findById;
  const originalUpdateOne = CommunitySubmission.updateOne;

  try {
    CommunitySubmission.findById = () => ({
      lean: () => Promise.resolve({
        _id: id,
        sourceType: 'community',
        status: 'NEW',
        isDeleted: false,
        reporterEmail: 'ravi@example.com',
      }),
    });

    CommunitySubmission.updateOne = () => Promise.resolve({ modifiedCount: 1 });

    const res = await request(app)
      .post(`/admin-api/admin/community-reporter/submissions/${id}/trash`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.action, 'soft_delete');
    assert.equal(res.body.affectsLiveSite, false);
    assert.equal(res.body.isDeleted, true);
  } finally {
    CommunitySubmission.findById = originalFindById;
    CommunitySubmission.updateOne = originalUpdateOne;
    restoreAudit();
    restoreUser();
    restoreMongo();
  }
});

test('Community Story Desk: restore moves deleted story back to previous status', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('admin');
  const id = '507f1f77bcf86cd799439012';

  const originalFindById = CommunitySubmission.findById;
  const originalUpdateOne = CommunitySubmission.updateOne;

  const calls = { update: [] };

  try {
    CommunitySubmission.findById = () => ({
      lean: () => Promise.resolve({
        _id: id,
        sourceType: 'community',
        status: 'DELETED',
        isDeleted: true,
        previousStatus: 'APPROVED',
      }),
    });

    CommunitySubmission.updateOne = (filter, update) => {
      calls.update.push({ filter, update });
      return Promise.resolve({ modifiedCount: 1 });
    };

    const res = await request(app)
      .post(`/admin-api/admin/community/my-stories/${id}/restore`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.action, 'restore');
    assert.equal(res.body.status, 'APPROVED');

    assert.equal(calls.update.length, 1);
    const upd = calls.update[0].update;
    assert.equal(upd.$set.isDeleted, false);
    assert.equal(upd.$set.status, 'APPROVED');
    assert.ok(upd.$unset && upd.$unset.previousStatus === 1);
  } finally {
    CommunitySubmission.findById = originalFindById;
    CommunitySubmission.updateOne = originalUpdateOne;
    restoreAudit();
    restoreUser();
    restoreMongo();
  }
});

test('Community Story Desk: withdraw alias works for /admin-api/community/stories/:id/withdraw', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('admin');
  const id = '507f1f77bcf86cd799439112';

  const originalFindById = CommunitySubmission.findById;
  const originalUpdateOne = CommunitySubmission.updateOne;

  const calls = { update: [] };

  try {
    CommunitySubmission.findById = () => ({
      lean: () => Promise.resolve({
        _id: id,
        sourceType: 'community',
        status: 'APPROVED',
        isDeleted: false,
      }),
    });

    CommunitySubmission.updateOne = (filter, update) => {
      calls.update.push({ filter, update });
      return Promise.resolve({ modifiedCount: 1 });
    };

    const res = await request(app)
      .post(`/admin-api/community/stories/${id}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.action, 'withdraw');
    assert.equal(res.body.status, 'WITHDRAWN');

    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].update.$set.status, 'WITHDRAWN');
    assert.ok(calls.update[0].update.$set.withdrawnAt);
  } finally {
    CommunitySubmission.findById = originalFindById;
    CommunitySubmission.updateOne = originalUpdateOne;
    restoreAudit();
    restoreUser();
    restoreMongo();
  }
});

test('Community Story Desk: withdraw alias works for /admin/community-reporter/submissions/:id/withdraw', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('admin');
  const id = '507f1f77bcf86cd799439114';

  const originalFindById = CommunitySubmission.findById;
  const originalUpdateOne = CommunitySubmission.updateOne;

  try {
    CommunitySubmission.findById = () => ({
      lean: () => Promise.resolve({
        _id: id,
        sourceType: 'community',
        status: 'APPROVED',
        isDeleted: false,
      }),
    });

    CommunitySubmission.updateOne = () => Promise.resolve({ modifiedCount: 1 });

    const res = await request(app)
      .post(`/admin-api/admin/community-reporter/submissions/${id}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.action, 'withdraw');
    assert.equal(res.body.affectsLiveSite, false);
    assert.equal(res.body.isDeleted, false);
  } finally {
    CommunitySubmission.findById = originalFindById;
    CommunitySubmission.updateOne = originalUpdateOne;
    restoreAudit();
    restoreUser();
    restoreMongo();
  }
});

test('Community Story Desk: permanent delete requires deleted state', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('admin');
  const id = '507f1f77bcf86cd799439013';

  const originalFindById = CommunitySubmission.findById;

  try {
    CommunitySubmission.findById = () => ({
      lean: () => Promise.resolve({ _id: id, sourceType: 'community', status: 'APPROVED', isDeleted: false }),
    });

    const res = await request(app)
      .delete(`/admin-api/admin/community/my-stories/${id}/permanent`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 409);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'STORY_NOT_DELETED_YET');
  } finally {
    CommunitySubmission.findById = originalFindById;
    restoreAudit();
    restoreUser();
    restoreMongo();
  }
});

test('Community Story Desk: permanent delete is founder/admin-only', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('staff');
  const id = '507f1f77bcf86cd799439014';

  // No need to stub DB calls; permission should fail first.
  const res = await request(app)
    .delete(`/admin-api/admin/community/my-stories/${id}/permanent`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'PERMISSION_DENIED');
  restoreAudit();
  restoreUser();
  restoreMongo();
});

test('Community Story Desk: permanent delete does not affect linked live article visibility', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('admin');
  const id = '507f1f77bcf86cd799439015';
  const linkedNewsId = '507f1f77bcf86cd799439099';

  const originalFindById = CommunitySubmission.findById;
  const originalNewsFindById = News.findById;
  const originalNewsUpdateOne = News.updateOne;
  const originalDeleteOne = CommunitySubmission.deleteOne;
  const originalReporterStoryLinkDeleteMany = ReporterStoryLink.deleteMany;

  const calls = { newsUpdate: 0, storyDelete: 0, linkDelete: 0 };

  try {
    CommunitySubmission.findById = () => ({
      lean: () => Promise.resolve({ _id: id, sourceType: 'community', status: 'DELETED', isDeleted: true, linkedArticleId: linkedNewsId }),
    });

    News.findById = () => ({
      select: () => ({
        lean: () => Promise.resolve({ communityReportId: id }),
      }),
    });

    News.updateOne = (_filter, update) => {
      calls.newsUpdate += 1;
      // Must NOT update status fields.
      assert.equal(Object.prototype.hasOwnProperty.call(update?.$set || {}, 'status'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(update?.$set || {}, 'publishedAt'), false);
      return Promise.resolve({ modifiedCount: 1 });
    };

    ReporterStoryLink.deleteMany = () => { calls.linkDelete += 1; return Promise.resolve({ deletedCount: 1 }); };
    CommunitySubmission.deleteOne = () => { calls.storyDelete += 1; return Promise.resolve({ deletedCount: 1 }); };

    const res = await request(app)
      .delete(`/admin-api/admin/community/my-stories/${id}/permanent`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.action, 'permanent_delete');
    assert.equal(res.body.affectsLiveSite, false);

    assert.equal(calls.newsUpdate, 1);
    assert.equal(calls.linkDelete, 1);
    assert.equal(calls.storyDelete, 1);
  } finally {
    CommunitySubmission.findById = originalFindById;
    News.findById = originalNewsFindById;
    News.updateOne = originalNewsUpdateOne;
    ReporterStoryLink.deleteMany = originalReporterStoryLinkDeleteMany;
    CommunitySubmission.deleteOne = originalDeleteOne;
    restoreAudit();
    restoreUser();
    restoreMongo();
  }
});

test('Community Story Desk: permanent delete cleans references and deletes story', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('admin');
  const id = '507f1f77bcf86cd799439016';
  const linkedNewsId = '507f1f77bcf86cd799439098';

  const originalFindById = CommunitySubmission.findById;
  const originalDeleteOne = CommunitySubmission.deleteOne;
  const originalNewsFindById = News.findById;
  const originalNewsUpdateOne = News.updateOne;
  const originalArticleFindOne = Article.findOne;
  const originalReporterStoryLinkDeleteMany = ReporterStoryLink.deleteMany;

  const calls = { newsUpdate: 0, linkDelete: 0, storyDelete: 0 };

  try {
    CommunitySubmission.findById = () => ({
      lean: () => Promise.resolve({
        _id: id,
        sourceType: 'community',
        status: 'DELETED',
        isDeleted: true,
        linkedArticleId: linkedNewsId,
      }),
    });

    News.findById = () => ({
      select: () => ({
        lean: () => Promise.resolve({ status: 'draft', deletedAt: null, locked: false, communityReportId: id }),
      }),
    });

    Article.findOne = () => ({
      select: () => ({
        lean: () => Promise.resolve(null),
      }),
    });

    News.updateOne = () => { calls.newsUpdate += 1; return Promise.resolve({ modifiedCount: 1 }); };
    ReporterStoryLink.deleteMany = () => { calls.linkDelete += 1; return Promise.resolve({ deletedCount: 2 }); };
    CommunitySubmission.deleteOne = () => { calls.storyDelete += 1; return Promise.resolve({ deletedCount: 1 }); };

    const res = await request(app)
      .delete(`/admin-api/admin/community/my-stories/${id}/permanent`)
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.action, 'permanent_delete');

    assert.equal(calls.newsUpdate, 1);
    assert.equal(calls.linkDelete, 1);
    assert.equal(calls.storyDelete, 1);
  } finally {
    CommunitySubmission.findById = originalFindById;
    CommunitySubmission.deleteOne = originalDeleteOne;
    News.findById = originalNewsFindById;
    News.updateOne = originalNewsUpdateOne;
    Article.findOne = originalArticleFindOne;
    ReporterStoryLink.deleteMany = originalReporterStoryLinkDeleteMany;
    restoreAudit();
    restoreUser();
    restoreMongo();
  }
});
