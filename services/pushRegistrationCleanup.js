const PushRegistration = require('../models/PushRegistration');

const DEFAULT_NON_DELIVERABLE_RETENTION_DAYS = 30;
const INVALID_TOKEN_FAILURE_CODES = Object.freeze([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getPushNonDeliverableRetentionDays(env = process.env) {
  return parsePositiveInteger(env.PUSH_NON_DELIVERABLE_RETENTION_DAYS, DEFAULT_NON_DELIVERABLE_RETENTION_DAYS);
}

function buildNonDeliverablePushRegistrationCleanupFilter(options = {}) {
  const retentionDays = parsePositiveInteger(options.retentionDays, getPushNonDeliverableRetentionDays(options.env));
  const now = options.now instanceof Date ? options.now : new Date();
  const cutoff = new Date(now.getTime() - (retentionDays * 24 * 60 * 60 * 1000));
  const activeDeliverableTokenGuard = {
    enabled: true,
    registrationType: 'token',
    registrationId: { $exists: true, $nin: [null, ''] },
    status: { $nin: ['inactive', 'disabled', 'stale'] },
  };
  const oldRegistrationTimestamp = {
    $or: [
      { lastRegisteredAt: { $lte: cutoff } },
      { updatedAt: { $lte: cutoff } },
      { createdAt: { $lte: cutoff } },
    ],
  };
  const missingDisabledAt = { $or: [{ disabledAt: { $exists: false } }, { disabledAt: null }] };
  const oldDisabledTimestamp = {
    $or: [
      { disabledAt: { $lte: cutoff } },
      { $and: [missingDisabledAt, oldRegistrationTimestamp] },
    ],
  };
  const oldInvalidTokenTimestamp = {
    $or: [
      { disabledAt: { $lte: cutoff } },
      { $and: [missingDisabledAt, { updatedAt: { $lte: cutoff } }] },
    ],
  };

  return {
    filter: {
      $and: [
        { $nor: [activeDeliverableTokenGuard] },
        {
          $or: [
            { $and: [{ registrationType: 'fid' }, oldRegistrationTimestamp] },
            { $and: [{ $or: [{ registrationId: { $exists: false } }, { registrationId: null }, { registrationId: '' }] }, oldRegistrationTimestamp] },
            { $and: [{ $or: [{ status: { $in: ['inactive', 'disabled', 'stale'] } }, { enabled: false }] }, oldDisabledTimestamp] },
            { $and: [{ enabled: false }, { lastFailureCode: { $in: INVALID_TOKEN_FAILURE_CODES } }, oldInvalidTokenTimestamp] },
          ],
        },
      ],
    },
    cutoff,
    retentionDays,
  };
}

async function cleanupNonDeliverablePushRegistrations(options = {}) {
  const model = options.model || PushRegistration;
  const { filter, cutoff, retentionDays } = buildNonDeliverablePushRegistrationCleanupFilter(options);
  const eligibleCount = typeof model.countDocuments === 'function' ? Number(await model.countDocuments(filter)) || 0 : null;

  if (options.dryRun) {
    return { ok: true, dryRun: true, retentionDays, cutoff, eligibleCount, deletedCount: 0 };
  }

  if (typeof model.deleteMany !== 'function') {
    throw new Error('PushRegistration.deleteMany is unavailable');
  }

  const result = await model.deleteMany(filter);
  return {
    ok: true,
    dryRun: false,
    retentionDays,
    cutoff,
    eligibleCount,
    deletedCount: Number(result?.deletedCount || result?.n || 0),
  };
}

module.exports = {
  DEFAULT_NON_DELIVERABLE_RETENTION_DAYS,
  INVALID_TOKEN_FAILURE_CODES,
  getPushNonDeliverableRetentionDays,
  buildNonDeliverablePushRegistrationCleanupFilter,
  cleanupNonDeliverablePushRegistrations,
};