const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret';

const app = require('../server');
const ReporterContact = require('../models/ReporterContact');
const ReporterProfile = require('../models/ReporterProfile');
const CommunitySubmission = require('../models/CommunitySubmission');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

function makeToken(role = 'admin') {
  return jwt.sign(
    { sub: '507f1f77bcf86cd799439011', email: 'admin@newspulse.ai', role, tokenVersion: 0, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function forceMongoReady() {
  const original = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  return () => {
    mongoose.connection.readyState = original;
  };
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
  return () => {
    AuditLog.create = originalCreate;
  };
}

test('POST /api/admin/community-reporter/contacts/bulk-delete rejects missing explicit confirmation with a stable contract', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('admin');

  try {
    const res = await request(app)
      .post('/api/admin/community-reporter/contacts/bulk-delete')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: ['507f1f77bcf86cd799439111'] });

    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.code, 'DELETE_CONFIRMATION_REQUIRED');
    assert.equal(res.body.invalidConfirmation, true);
    assert.equal(res.body.message, 'Permanent delete requires explicit confirmation via { ids: [...], confirmPermanentDelete: true }.');
    assert.deepStrictEqual(res.body.details, {
      endpoint: '/api/admin/community-reporter/contacts/bulk-delete',
      method: 'POST',
      requiredPayload: {
        ids: ['contactId'],
        confirmPermanentDelete: true,
      },
      confirmationField: 'confirmPermanentDelete',
      confirmationType: 'boolean',
      confirmationValue: true,
      legacyConfirmationFallbacks: ['confirm=true', 'confirmed=true', 'confirmationText=DELETE'],
      allowedState: 'removed',
    });
  } finally {
    restoreAudit();
    restoreUser();
    restoreMongo();
  }
});

test('POST /api/admin/community-reporter/contacts/bulk-delete supports single selected removed contact with the same contract', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('admin');

  const originalCountDocuments = ReporterContact.countDocuments;
  const originalFindById = ReporterContact.findById;
  const originalDeleteOne = ReporterContact.deleteOne;
  const originalSubmissionCountDocuments = CommunitySubmission.countDocuments;
  const originalSubmissionUpdateMany = CommunitySubmission.updateMany;
  const originalProfileCountDocuments = ReporterProfile.countDocuments;
  const originalProfileUpdateMany = ReporterProfile.updateMany;

  const removedId = '507f1f77bcf86cd799439124';
  const deletedFilters = [];

  try {
    ReporterContact.countDocuments = async () => 1;
    ReporterContact.findById = async (id) => {
      if (id === removedId) return { _id: removedId, email: 'single-removed@example.com', directoryStatus: 'removed' };
      return null;
    };
    ReporterContact.deleteOne = async (filter) => {
      deletedFilters.push(filter);
      return { acknowledged: true, deletedCount: 1 };
    };
    CommunitySubmission.countDocuments = async () => 0;
    CommunitySubmission.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });
    ReporterProfile.countDocuments = async () => 0;
    ReporterProfile.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });

    const res = await request(app)
      .post('/api/admin/community-reporter/contacts/bulk-delete')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [removedId], confirmPermanentDelete: true });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.successCount, 1);
    assert.equal(res.body.deletedCount, 1);
    assert.deepStrictEqual(res.body.deletedIds, [removedId]);
    assert.equal(res.body.failedCount, 0);
    assert.deepStrictEqual(res.body.failedIds, []);
    assert.equal(res.body.missingCount, 0);
    assert.deepStrictEqual(res.body.missingIds, []);
    assert.equal(res.body.invalidStateCount, 0);
    assert.deepStrictEqual(res.body.invalidStateIds, []);
    assert.deepStrictEqual(deletedFilters, [{ _id: removedId }]);
  } finally {
    ReporterContact.countDocuments = originalCountDocuments;
    ReporterContact.findById = originalFindById;
    ReporterContact.deleteOne = originalDeleteOne;
    CommunitySubmission.countDocuments = originalSubmissionCountDocuments;
    CommunitySubmission.updateMany = originalSubmissionUpdateMany;
    ReporterProfile.countDocuments = originalProfileCountDocuments;
    ReporterProfile.updateMany = originalProfileUpdateMany;
    restoreAudit();
    restoreUser();
    restoreMongo();
  }
});

test('POST /api/admin/community-reporter/contacts/bulk-delete accepts confirmPermanentDelete=true and deletes only removed contacts', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('admin');

  const originalCountDocuments = ReporterContact.countDocuments;
  const originalFindById = ReporterContact.findById;
  const originalDeleteOne = ReporterContact.deleteOne;
  const originalSubmissionCountDocuments = CommunitySubmission.countDocuments;
  const originalSubmissionUpdateMany = CommunitySubmission.updateMany;
  const originalProfileCountDocuments = ReporterProfile.countDocuments;
  const originalProfileUpdateMany = ReporterProfile.updateMany;

  const removedId = '507f1f77bcf86cd799439121';
  const activeId = '507f1f77bcf86cd799439122';
  const missingId = '507f1f77bcf86cd799439123';
  const deletedFilters = [];

  try {
    ReporterContact.countDocuments = async () => 2;
    ReporterContact.findById = async (id) => {
      if (id === removedId) return { _id: removedId, email: 'removed@example.com', directoryStatus: 'removed' };
      if (id === activeId) return { _id: activeId, email: 'active@example.com', directoryStatus: 'active' };
      return null;
    };
    ReporterContact.deleteOne = async (filter) => {
      deletedFilters.push(filter);
      return { acknowledged: true, deletedCount: 1 };
    };
    CommunitySubmission.countDocuments = async () => 0;
    CommunitySubmission.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });
    ReporterProfile.countDocuments = async () => 0;
    ReporterProfile.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });

    const res = await request(app)
      .post('/api/admin/community-reporter/contacts/bulk-delete')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ids: [removedId, activeId, missingId],
        confirmPermanentDelete: true,
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.mode, 'hard');
    assert.equal(res.body.successCount, 1);
    assert.equal(res.body.deletedCount, 1);
    assert.deepStrictEqual(res.body.deletedIds, [removedId]);
    assert.equal(res.body.failedCount, 2);
    assert.deepStrictEqual(res.body.failedIds, [activeId, missingId]);
    assert.equal(res.body.missingCount, 1);
    assert.deepStrictEqual(res.body.missingIds, [missingId]);
    assert.equal(res.body.invalidStateCount, 1);
    assert.deepStrictEqual(res.body.invalidStateIds, [activeId]);
    assert.deepStrictEqual(res.body.requestContract, {
      endpoint: '/api/admin/community-reporter/contacts/bulk-delete',
      method: 'POST',
      requiredPayload: {
        ids: ['contactId'],
        confirmPermanentDelete: true,
      },
      confirmationField: 'confirmPermanentDelete',
      confirmationType: 'boolean',
      confirmationValue: true,
      legacyConfirmationFallbacks: ['confirm=true', 'confirmed=true', 'confirmationText=DELETE'],
      allowedState: 'removed',
    });
    assert.deepStrictEqual(deletedFilters, [{ _id: removedId }]);
  } finally {
    ReporterContact.countDocuments = originalCountDocuments;
    ReporterContact.findById = originalFindById;
    ReporterContact.deleteOne = originalDeleteOne;
    CommunitySubmission.countDocuments = originalSubmissionCountDocuments;
    CommunitySubmission.updateMany = originalSubmissionUpdateMany;
    ReporterProfile.countDocuments = originalProfileCountDocuments;
    ReporterProfile.updateMany = originalProfileUpdateMany;
    restoreAudit();
    restoreUser();
    restoreMongo();
  }
});

test('POST /api/admin/community-reporter/contacts/bulk-delete detaches linked stories and contributor profiles before deleting', async () => {
  const restoreMongo = forceMongoReady();
  const restoreUser = stubUserLookups();
  const restoreAudit = stubAuditCreate();
  const token = makeToken('admin');

  const originalCountDocuments = ReporterContact.countDocuments;
  const originalFindById = ReporterContact.findById;
  const originalDeleteOne = ReporterContact.deleteOne;
  const originalSubmissionUpdateMany = CommunitySubmission.updateMany;
  const originalProfileUpdateMany = ReporterProfile.updateMany;

  const removedId = '507f1f77bcf86cd799439125';
  const submissionUpdates = [];
  const profileUpdates = [];

  try {
    ReporterContact.countDocuments = async () => 1;
    ReporterContact.findById = async (id) => {
      if (id === removedId) return { _id: removedId, email: 'detach-route@example.com', directoryStatus: 'removed' };
      return null;
    };
    ReporterContact.deleteOne = async () => ({ acknowledged: true, deletedCount: 1 });
    CommunitySubmission.updateMany = async (filter, update) => {
      submissionUpdates.push({ filter, update });
      return { acknowledged: true, modifiedCount: submissionUpdates.length };
    };
    ReporterProfile.updateMany = async (filter, update) => {
      profileUpdates.push({ filter, update });
      return { acknowledged: true, modifiedCount: 1 };
    };

    const res = await request(app)
      .post('/api/admin/community-reporter/contacts/bulk-delete')
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [removedId], confirmPermanentDelete: true });

    assert.equal(res.status, 200);
    assert.equal(res.body.deletedCount, 1);
    assert.deepStrictEqual(submissionUpdates[0], {
      filter: { reporterId: removedId },
      update: { $set: { reporterId: null } },
    });
    assert.deepStrictEqual(profileUpdates, [
      {
        filter: { reporterContactId: removedId },
        update: { $set: { reporterContactId: null } },
      },
    ]);
  } finally {
    ReporterContact.countDocuments = originalCountDocuments;
    ReporterContact.findById = originalFindById;
    ReporterContact.deleteOne = originalDeleteOne;
    CommunitySubmission.updateMany = originalSubmissionUpdateMany;
    ReporterProfile.updateMany = originalProfileUpdateMany;
    restoreAudit();
    restoreUser();
    restoreMongo();
  }
});