const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const User = require('../models/User');
const { FOUNDER_STAFF_ID } = require('./staffId');
const { FOUNDER_PERMISSIONS } = require('./teamAccess');

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function safeLogger(logger) {
  return logger && typeof logger.log === 'function' ? logger : console;
}

async function seedFounderFromEnvIfNeeded(options = {}) {
  const logger = safeLogger(options.logger);
  if (!isDbReady()) return { skipped: true, reason: 'db_unavailable' };

  const existingFounder = await User.findOne({ $or: [{ isFounder: true }, { role: 'founder' }] }).lean();
  if (existingFounder) return { skipped: true, reason: 'founder_exists' };

  const email = String(process.env.FOUNDER_EMAIL || '').trim().toLowerCase();
  const fullName = String(process.env.FOUNDER_NAME || '').trim();
  const temporaryPassword = String(process.env.FOUNDER_TEMP_PASSWORD || '').trim();

  if (!email || !fullName || !temporaryPassword) {
    logger.log('[startup][founder-seed] skipped', {
      reason: 'missing_env',
      hasFounderEmail: Boolean(email),
      hasFounderName: Boolean(fullName),
      hasFounderTempPassword: Boolean(temporaryPassword),
    });
    return { skipped: true, reason: 'missing_env' };
  }

  const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
  const passwordHash = await bcrypt.hash(temporaryPassword, rounds);
  const tempPasswordExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const created = await User.create({
    fullName,
    name: fullName,
    email,
    staffId: FOUNDER_STAFF_ID,
    staffIdGeneratedAt: new Date(),
    staffIdLocked: true,
    role: 'founder',
    department: 'Founder Office',
    sections: [],
    permissions: FOUNDER_PERMISSIONS.slice(),
    passwordHash,
    status: 'active',
    mustChangePassword: true,
    mustResetPassword: true,
    forceReset: true,
    tempPasswordExpiresAt,
    isFounder: true,
    isProtected: true,
    tokenVersion: 0,
    failedLoginCount: 0,
    lockedUntil: null,
    accessExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  logger.log('[startup][founder-seed] created', {
    userId: String(created._id),
    email,
    tempPasswordExpiresAt,
    mustChangePassword: true,
  });
  return { skipped: false, created: true, userId: String(created._id) };
}

module.exports = { seedFounderFromEnvIfNeeded };