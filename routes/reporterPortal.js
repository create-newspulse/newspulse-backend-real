const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const CommunitySubmission = require('../models/CommunitySubmission');
const OtpToken = require('../models/OtpToken');
const ReporterContact = require('../models/ReporterContact');
const ActivityLog = require('../models/ActivityLog');
const { sendMail, getTransporter, getMailerStatus } = require('../lib/mailer');
const { sendEmail: sendEmailStub } = require('../lib/emailStub');
const { extractSubmissionAttachments, inferSubmissionDeskMetadata } = require('../services/communitySubmissionWorkflow');
const { requireReporterPortalAuth, requireReporterPortalOpen } = require('../middleware/reporterPortalAuth');

const router = express.Router();

const REPORTER_PORTAL_OTP_PURPOSE = 'reporter_portal_login';
const REPORTER_PORTAL_EMAIL_CHANGE_OTP_PURPOSE = 'reporter_portal_email_change';
const OTP_EXPIRY_MS = 10 * 60 * 1000;
const OTP_REQUEST_RATE_LIMIT = { windowMs: 15 * 60 * 1000, maxAttempts: 8 };
const OTP_VERIFY_RATE_LIMIT = { windowMs: 10 * 60 * 1000, maxAttempts: 10 };
const otpRequestAttempts = new Map();
const otpVerifyAttempts = new Map();

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function maskEmail(email) {
  try {
    const [user, domain] = String(email || '').split('@');
    if (!user || !domain) return email;
    return `${user.slice(0, Math.min(2, user.length))}***@${domain}`;
  } catch (_) {
    return email;
  }
}

function getClientIp(req) {
  return String(
    req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip
    || req.socket?.remoteAddress
    || 'unknown'
  ).trim();
}

function getRateLimitKey(req, subject) {
  return `${getClientIp(req)}|${String(subject || '').trim().toLowerCase()}`;
}

function consumeRateLimit(store, key, options) {
  const now = Date.now();
  const current = Array.isArray(store.get(key)) ? store.get(key) : [];
  const fresh = current.filter((ts) => now - ts < options.windowMs);
  fresh.push(now);
  store.set(key, fresh);
  return { limited: fresh.length > options.maxAttempts, remaining: Math.max(options.maxAttempts - fresh.length, 0) };
}

function clearRateLimit(store, key) {
  store.delete(key);
}

async function logReporterActivity(type, email, meta = {}) {
  try {
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return;
    if (!mongoose.connection || mongoose.connection.readyState !== 1) return;
    await ActivityLog.create({ type, email: normalizeEmail(email), meta });
  } catch (_) {}
}

function getReporterJwtExpiresIn() {
  return String(process.env.REPORTER_PORTAL_JWT_EXPIRES_IN || '24h').trim() || '24h';
}

function getTokenExpiresAt(token) {
  try {
    const payload = jwt.decode(token);
    if (payload && payload.exp) return new Date(payload.exp * 1000);
  } catch (_) {}
  return null;
}

function mapReporterProfile(reporter) {
  return {
    id: reporter && reporter._id ? String(reporter._id) : null,
    email: normalizeEmail(reporter && (reporter.email || reporter.emailLower)),
    fullName: reporter && reporter.fullName ? reporter.fullName : 'Reporter',
    reporterType: reporter && reporter.reporterType ? reporter.reporterType : 'community',
    verificationLevel: reporter && reporter.verificationLevel ? reporter.verificationLevel : 'community_default',
    portalAccessEnabled: reporter ? reporter.portalAccessEnabled !== false : true,
    status: reporter && reporter.status ? reporter.status : 'active',
    phone: reporter && reporter.phoneFull ? reporter.phoneFull : null,
    country: reporter && reporter.country ? reporter.country : null,
    stateName: reporter && reporter.stateName ? reporter.stateName : null,
    districtName: reporter && reporter.districtName ? reporter.districtName : null,
    cityTownVillage: reporter && reporter.cityTownVillage ? reporter.cityTownVillage : null,
    pendingPortalEmail: reporter && reporter.pendingPortalEmail ? reporter.pendingPortalEmail : null,
    lastPortalLoginAt: reporter && reporter.lastPortalLoginAt ? reporter.lastPortalLoginAt : null,
  };
}

function mapVerificationLevelForSubmission(contact) {
  const verificationLevel = String(contact && contact.verificationLevel || '').toLowerCase();
  if (verificationLevel === 'verified') return 'journalist_verified';
  if (verificationLevel === 'pending') return 'journalist_pending';
  return 'unverified';
}

function toPortalStatus(rawStatus) {
  const value = normalizeToken(rawStatus);
  if (value === 'draft') return 'DRAFT';
  if (value === 'submitted') return 'SUBMITTED';
  if (value === 'needs-revision' || value === 'revision-requested') return 'NEEDS_REVISION';
  if (value === 'approved') return 'APPROVED';
  if (value === 'published' || value === 'publish') return 'PUBLISHED';
  if (['rejected', 'trash', 'discarded', 'deleted', 'withdrawn', 'archived'].includes(value)) return 'REJECTED';
  return 'UNDER_REVIEW';
}

function toStoredStatusForCreate(action) {
  return normalizeToken(action) === 'draft' ? 'DRAFT' : 'SUBMITTED';
}

function toStoredStatusForUpdate(currentPortalStatus, action) {
  const normalizedAction = normalizeToken(action);
  if (currentPortalStatus === 'DRAFT') {
    return normalizedAction === 'submit' || normalizedAction === 'submitted' ? 'SUBMITTED' : 'DRAFT';
  }
  if (currentPortalStatus === 'NEEDS_REVISION') {
    return normalizedAction === 'submit' || normalizedAction === 'submitted' ? 'SUBMITTED' : 'NEEDS_REVISION';
  }
  return null;
}

function canEditSubmission(doc) {
  const portalStatus = toPortalStatus(doc && doc.status);
  return portalStatus === 'DRAFT' || portalStatus === 'NEEDS_REVISION';
}

function matchesPortalStatus(rawStatus, requestedStatus) {
  const requested = normalizeToken(requestedStatus);
  if (!requested || requested === 'all') return true;
  const portalStatus = toPortalStatus(rawStatus);
  if (requested === 'pending') {
    return ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'NEEDS_REVISION'].includes(portalStatus);
  }
  return portalStatus === requested.toUpperCase().replace(/-/g, '_');
}

function buildReporterOwnershipFilter(reporter) {
  const email = normalizeEmail(reporter && reporter.email);
  const clauses = [];
  if (reporter && reporter.reporterId && mongoose.isValidObjectId(String(reporter.reporterId))) {
    clauses.push({ reporterId: reporter.reporterId });
  }
  if (email) {
    clauses.push({ reporterEmailNorm: email });
    clauses.push({ reporterEmail: email });
    clauses.push({ email });
    clauses.push({ 'contact.email': email });
  }

  return {
    isDeleted: { $ne: true },
    ...(clauses.length ? { $or: clauses } : {}),
  };
}

function applySubmissionPatch(doc, payload = {}, reporter) {
  const headline = typeof payload.headline === 'string' ? payload.headline.trim() : undefined;
  const story = typeof payload.story === 'string'
    ? payload.story.trim()
    : (typeof payload.body === 'string' ? payload.body.trim() : undefined);
  const category = typeof payload.category === 'string' ? payload.category.trim() : undefined;
  const phone = typeof payload.phone === 'string'
    ? payload.phone.trim()
    : (typeof payload.contactPhone === 'string' ? payload.contactPhone.trim() : undefined);
  const location = payload.location;
  const locationText = typeof location === 'string' ? location.trim() : '';
  const locationParts = locationText ? locationText.split(',').map((part) => part.trim()).filter(Boolean) : [];
  const locationObj = location && typeof location === 'object' ? location : null;
  const city = typeof payload.city === 'string'
    ? payload.city.trim()
    : (locationObj && typeof locationObj.city === 'string' ? locationObj.city.trim() : (locationParts[0] || ''));
  const state = typeof payload.state === 'string'
    ? payload.state.trim()
    : (locationObj && typeof locationObj.state === 'string' ? locationObj.state.trim() : (locationParts[1] || ''));
  const country = typeof payload.country === 'string'
    ? payload.country.trim()
    : (locationObj && typeof locationObj.country === 'string' ? locationObj.country.trim() : (locationParts[2] || ''));

  if (headline !== undefined) doc.headline = headline;
  if (story !== undefined) doc.body = story;
  if (category !== undefined) doc.category = category || null;
  if (locationText || locationObj || city || state || country) {
    doc.location = {
      city: city || null,
      state: state || null,
      country: country || null,
    };
    doc.city = city || undefined;
    doc.state = state || undefined;
    doc.country = country || undefined;
    doc.reporterLocation = locationText || city || undefined;
  }

  doc.contact = doc.contact && typeof doc.contact === 'object' ? doc.contact : {};
  doc.contact.name = reporter.fullName || doc.contact.name || doc.reporterName || doc.name;
  doc.contact.email = reporter.email || doc.contact.email || doc.reporterEmail || doc.email;
  if (phone !== undefined) doc.contact.phone = phone || undefined;

  const attachments = extractSubmissionAttachments(payload);
  if (attachments.length) {
    doc.attachments = attachments;
    doc.mediaUrl = attachments[0] && attachments[0].url ? attachments[0].url : doc.mediaUrl;
    doc.mediaLink = attachments[0] && attachments[0].url ? attachments[0].url : doc.mediaLink;
  }

  const deskMeta = inferSubmissionDeskMetadata(payload);
  if (deskMeta.desk) doc.desk = deskMeta.desk;
  if (deskMeta.submissionType) doc.submissionType = deskMeta.submissionType;
  if (deskMeta.intakeSource) doc.intakeSource = deskMeta.intakeSource;
  if (deskMeta.track) {
    doc.track = deskMeta.track;
    if (!doc.category) doc.category = deskMeta.track;
  }
}

function mapSubmission(doc) {
  const location = doc && (doc.location || doc.locationDetail) ? (doc.location || doc.locationDetail) : null;
  return {
    id: doc && doc._id ? String(doc._id) : null,
    headline: doc && doc.headline ? doc.headline : '',
    story: doc && doc.body ? doc.body : '',
    category: doc && doc.category ? doc.category : null,
    desk: doc && doc.desk ? doc.desk : null,
    track: doc && doc.track ? doc.track : null,
    portalStatus: toPortalStatus(doc && doc.status),
    rawStatus: doc && doc.status ? doc.status : null,
    canEdit: canEditSubmission(doc),
    createdAt: doc && doc.createdAt ? doc.createdAt : null,
    updatedAt: doc && doc.updatedAt ? doc.updatedAt : null,
    attachments: Array.isArray(doc && doc.attachments) ? doc.attachments : [],
    location,
    contact: doc && doc.contact ? {
      name: doc.contact.name || null,
      email: doc.contact.email || null,
      phone: doc.contact.phone || null,
    } : null,
    linkedArticleId: doc && doc.linkedArticleId ? String(doc.linkedArticleId) : null,
    articleId: doc && doc.articleId ? String(doc.articleId) : null,
  };
}

function buildSummary(submissions) {
  const summary = {
    totalSubmissions: submissions.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    published: 0,
  };
  const breakdown = {
    DRAFT: 0,
    SUBMITTED: 0,
    UNDER_REVIEW: 0,
    NEEDS_REVISION: 0,
    APPROVED: 0,
    REJECTED: 0,
    PUBLISHED: 0,
  };

  submissions.forEach((submission) => {
    const portalStatus = toPortalStatus(submission && submission.status);
    breakdown[portalStatus] = (breakdown[portalStatus] || 0) + 1;
    if (['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'NEEDS_REVISION'].includes(portalStatus)) summary.pending += 1;
    if (portalStatus === 'APPROVED') summary.approved += 1;
    if (portalStatus === 'REJECTED') summary.rejected += 1;
    if (portalStatus === 'PUBLISHED') summary.published += 1;
  });

  return { summary, breakdown };
}

async function sendReporterOtpEmail(email, code) {
  const subject = 'News Pulse Reporter Portal OTP';
  const text = `Your News Pulse Reporter Portal OTP is: ${code}. It is valid for 10 minutes.`;
  const stubMode = (process.env.EMAIL_MODE || '').toLowerCase() === 'stub';

  if (stubMode) {
    await sendEmailStub({ to: email, subject, text });
    return { method: 'stub' };
  }

  const transporter = getTransporter();
  if (!transporter) throw new Error('Email transporter not configured');
  const info = await sendMail({ to: email, subject, text, html: `<p>${text}</p>` });
  const accepted = Array.isArray(info && info.accepted) ? info.accepted.map((value) => String(value || '').toLowerCase()) : [];
  if (!accepted.includes(email)) {
    throw new Error('SMTP did not accept recipient');
  }
  return { method: 'email' };
}

async function resolveReporterFromEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  let reporter = await ReporterContact.findOne({ $or: [{ email: normalizedEmail }, { emailLower: normalizedEmail }] });
  if (reporter) return reporter;

  const latestSubmission = await CommunitySubmission.findOne({
    isDeleted: { $ne: true },
    $or: [
      { reporterEmailNorm: normalizedEmail },
      { reporterEmail: normalizedEmail },
      { email: normalizedEmail },
      { 'contact.email': normalizedEmail },
    ],
  }).sort({ createdAt: -1 });

  if (!latestSubmission) return null;

  const { upsertReporterContactFromSubmission } = require('../services/reporterContactService');
  const result = await upsertReporterContactFromSubmission(latestSubmission.toObject ? latestSubmission.toObject() : latestSubmission);
  reporter = result && result.contact ? result.contact : null;
  if (!reporter && result && result.contactId) {
    reporter = await ReporterContact.findById(result.contactId);
  }
  return reporter;
}

async function backfillReporterOwnership(reporter) {
  if (!reporter || !reporter._id) return;
  const normalizedEmail = normalizeEmail(reporter.email || reporter.emailLower);
  if (!normalizedEmail) return;

  await CommunitySubmission.updateMany(
    {
      isDeleted: { $ne: true },
      reporterId: { $exists: false },
      $or: [
        { reporterEmailNorm: normalizedEmail },
        { reporterEmail: normalizedEmail },
        { email: normalizedEmail },
        { 'contact.email': normalizedEmail },
      ],
    },
    {
      $set: {
        reporterId: reporter._id,
        reporterEmailNorm: normalizedEmail,
      },
    }
  ).catch(() => {});
}

async function updateReporterSubmissionIdentity(reporter, nextEmail, nextName) {
  if (!reporter || !reporter._id) return;
  const email = normalizeEmail(nextEmail || reporter.email || reporter.emailLower);
  const name = String(nextName || reporter.fullName || 'Reporter').trim() || 'Reporter';

  await CommunitySubmission.updateMany(
    {
      isDeleted: { $ne: true },
      reporterId: reporter._id,
    },
    {
      $set: {
        reporterEmail: email,
        reporterEmailNorm: email,
        email,
        reporterName: name,
        name,
        'contact.email': email,
        'contact.name': name,
      },
    }
  ).catch(() => {});
}

function buildReporterToken(reporter) {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret) throw new Error('JWT_SECRET missing');

  return jwt.sign(
    {
      sub: String(reporter._id),
      reporterId: String(reporter._id),
      email: normalizeEmail(reporter.email || reporter.emailLower),
      fullName: reporter.fullName || 'Reporter',
      reporterType: reporter.reporterType || 'community',
      verificationLevel: reporter.verificationLevel || 'community_default',
      portalAccessEnabled: reporter.portalAccessEnabled !== false,
      portalAuthVersion: typeof reporter.portalAuthVersion === 'number' ? reporter.portalAuthVersion : 0,
      status: reporter.status || 'active',
      type: 'reporter_portal',
    },
    secret,
    { expiresIn: getReporterJwtExpiresIn() }
  );
}

async function loadOwnedSubmissions(reporter) {
  const filter = buildReporterOwnershipFilter(reporter);
  const docs = await CommunitySubmission.find(filter).sort({ createdAt: -1 });
  return Array.isArray(docs) ? docs : [];
}

router.post('/auth/request-login-otp', requireReporterPortalOpen, async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) {
      return res.status(400).json({ ok: false, code: 'EMAIL_REQUIRED', message: 'Email is required.' });
    }

    const mailerStatus = getMailerStatus();
    if (!mailerStatus.configured) {
      console.error('[reporter-portal][request-login-otp] mailer unavailable', { missing: mailerStatus.missing });
      return res.status(503).json({
        ok: false,
        code: 'EMAIL_SERVICE_UNAVAILABLE',
        message: 'Verification email service is temporarily unavailable.',
      });
    }

    const rateLimitKey = getRateLimitKey(req, email);
    const requestLimit = consumeRateLimit(otpRequestAttempts, rateLimitKey, OTP_REQUEST_RATE_LIMIT);
    if (requestLimit.limited) {
      await logReporterActivity('reporter_portal_otp_request_rate_limited', email, { ip: getClientIp(req) });
      return res.status(429).json({ ok: false, code: 'OTP_REQUEST_RATE_LIMITED', message: 'Too many OTP requests. Please try again later.' });
    }

    const reporter = await resolveReporterFromEmail(email);
    if (!reporter) {
      await logReporterActivity('reporter_portal_otp_request_unknown_email', email, { ip: getClientIp(req) });
      return res.status(200).json({ ok: true, message: 'If a reporter account exists for this email, an OTP has been sent.' });
    }

    const status = String(reporter.status || 'active').toLowerCase();
    if (status === 'suspended' || status === 'banned' || reporter.portalAccessEnabled === false) {
      await logReporterActivity('reporter_portal_otp_request_blocked', email, { ip: getClientIp(req), status, portalAccessEnabled: reporter.portalAccessEnabled !== false });
      return res.status(200).json({ ok: true, message: 'If a reporter account exists for this email, an OTP has been sent.' });
    }

    await OtpToken.updateMany(
      { email, purpose: REPORTER_PORTAL_OTP_PURPOSE, used: false },
      { $set: { used: true } }
    );

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
    const codeHash = await bcrypt.hash(code, 10);
    await OtpToken.create({ email, purpose: REPORTER_PORTAL_OTP_PURPOSE, codeHash, expiresAt, used: false });
    await sendReporterOtpEmail(email, code);
    await logReporterActivity('reporter_portal_otp_requested', email, { ip: getClientIp(req), reporterId: reporter && reporter._id ? String(reporter._id) : null });

    return res.status(200).json({
      ok: true,
      message: 'If a reporter account exists for this email, an OTP has been sent.',
      emailMasked: maskEmail(email),
      ...((process.env.NODE_ENV === 'test' || String(process.env.OTP_DEV_ECHO || '') === '1') ? { devCode: code } : {}),
    });
  } catch (error) {
    console.error('[reporter-portal][request-login-otp] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'OTP_REQUEST_FAILED', message: 'Failed to request login OTP.' });
  }
});

router.post('/auth/verify-login-otp', requireReporterPortalOpen, async (req, res) => {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    const otp = String(req.body && (req.body.otp || req.body.code) || '').trim();
    if (!email || !otp) {
      return res.status(400).json({ ok: false, code: 'OTP_REQUIRED', message: 'Email and OTP are required.' });
    }

    const rateLimitKey = getRateLimitKey(req, email);
    const verifyLimit = consumeRateLimit(otpVerifyAttempts, rateLimitKey, OTP_VERIFY_RATE_LIMIT);
    if (verifyLimit.limited) {
      await logReporterActivity('reporter_portal_otp_verify_rate_limited', email, { ip: getClientIp(req) });
      return res.status(429).json({ ok: false, code: 'OTP_VERIFY_RATE_LIMITED', message: 'Too many verification attempts. Please try again later.' });
    }

    const otpRecord = await OtpToken.findOne({ email, purpose: REPORTER_PORTAL_OTP_PURPOSE, used: false }).sort({ createdAt: -1 });
    if (!otpRecord || !otpRecord.expiresAt || new Date() > new Date(otpRecord.expiresAt)) {
      await logReporterActivity('reporter_portal_otp_verify_failed', email, { ip: getClientIp(req), reason: 'expired_or_missing' });
      return res.status(400).json({ ok: false, code: 'INVALID_OTP', message: 'Invalid or expired OTP.' });
    }

    const matches = await bcrypt.compare(otp, otpRecord.codeHash);
    if (!matches) {
      await logReporterActivity('reporter_portal_otp_verify_failed', email, { ip: getClientIp(req), reason: 'invalid_code' });
      return res.status(400).json({ ok: false, code: 'INVALID_OTP', message: 'Invalid or expired OTP.' });
    }

    clearRateLimit(otpVerifyAttempts, rateLimitKey);

    otpRecord.used = true;
    if (typeof otpRecord.save === 'function') {
      await otpRecord.save();
    }

    const reporter = await resolveReporterFromEmail(email);
    if (!reporter) {
      await logReporterActivity('reporter_portal_login_failed', email, { ip: getClientIp(req), reason: 'reporter_not_found' });
      return res.status(403).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }

    const status = String(reporter.status || 'active').toLowerCase();
    if (status === 'suspended' || status === 'banned' || reporter.portalAccessEnabled === false) {
      await logReporterActivity('reporter_portal_login_blocked', email, { ip: getClientIp(req), status, portalAccessEnabled: reporter.portalAccessEnabled !== false });
      return res.status(403).json({ ok: false, code: 'REPORTER_PORTAL_FORBIDDEN', message: 'Reporter portal access is disabled for this account.' });
    }

    reporter.lastPortalLoginAt = new Date();
    if (typeof reporter.save === 'function') {
      await reporter.save();
    } else {
      await ReporterContact.findOneAndUpdate({ _id: reporter._id }, { $set: { lastPortalLoginAt: new Date() } });
    }

    await backfillReporterOwnership(reporter);

    const token = buildReporterToken(reporter);
    const expiresAt = getTokenExpiresAt(token);
    const submissions = await loadOwnedSubmissions({ reporterId: reporter._id, email });
    const { summary } = buildSummary(submissions);
    await logReporterActivity('reporter_portal_login', email, { ip: getClientIp(req), reporterId: String(reporter._id), expiresAt });

    return res.status(200).json({
      ok: true,
      token,
      expiresAt,
      reporter: {
        id: String(reporter._id),
        email,
        fullName: reporter.fullName || 'Reporter',
        reporterType: reporter.reporterType || 'community',
        verificationLevel: reporter.verificationLevel || 'community_default',
      },
      summary,
    });
  } catch (error) {
    console.error('[reporter-portal][verify-login-otp] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'OTP_VERIFY_FAILED', message: 'Failed to verify login OTP.' });
  }
});

router.post('/auth/logout', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const reporterDoc = req._reporterPortalDoc || await ReporterContact.findById(req.reporterPortal.reporterId);
    if (!reporterDoc) {
      return res.status(404).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }

    const currentVersion = typeof reporterDoc.portalAuthVersion === 'number' ? reporterDoc.portalAuthVersion : 0;
    reporterDoc.portalAuthVersion = currentVersion + 1;
    await reporterDoc.save();
    await logReporterActivity('reporter_portal_logout', req.reporterPortal.email, { ip: getClientIp(req), reporterId: String(reporterDoc._id) });
    return res.status(200).json({ ok: true, message: 'Logged out successfully.' });
  } catch (error) {
    console.error('[reporter-portal][logout] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'LOGOUT_FAILED', message: 'Failed to logout.' });
  }
});

router.get('/profile', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const reporterDoc = req._reporterPortalDoc || await ReporterContact.findById(req.reporterPortal.reporterId);
    if (!reporterDoc) {
      return res.status(404).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }
    return res.status(200).json({ ok: true, profile: mapReporterProfile(reporterDoc) });
  } catch (error) {
    console.error('[reporter-portal][profile] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'PROFILE_LOAD_FAILED', message: 'Failed to load profile.' });
  }
});

router.patch('/profile', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const reporterDoc = req._reporterPortalDoc || await ReporterContact.findById(req.reporterPortal.reporterId);
    if (!reporterDoc) {
      return res.status(404).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }

    const requestedEmail = normalizeEmail(req.body && req.body.email);
    if (requestedEmail && requestedEmail !== normalizeEmail(reporterDoc.email || reporterDoc.emailLower)) {
      return res.status(400).json({ ok: false, code: 'EMAIL_REVERIFICATION_REQUIRED', message: 'Use the verified email change flow to change your login email.' });
    }

    const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : undefined;
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : undefined;
    const country = typeof req.body?.country === 'string' ? req.body.country.trim() : undefined;
    const stateName = typeof req.body?.stateName === 'string' ? req.body.stateName.trim() : undefined;
    const districtName = typeof req.body?.districtName === 'string' ? req.body.districtName.trim() : undefined;
    const cityTownVillage = typeof req.body?.cityTownVillage === 'string' ? req.body.cityTownVillage.trim() : undefined;

    if (fullName !== undefined) reporterDoc.fullName = fullName || reporterDoc.fullName;
    if (phone !== undefined) reporterDoc.phoneFull = phone || undefined;
    if (country !== undefined) reporterDoc.country = country || reporterDoc.country;
    if (stateName !== undefined) reporterDoc.stateName = stateName || undefined;
    if (districtName !== undefined) reporterDoc.districtName = districtName || undefined;
    if (cityTownVillage !== undefined) reporterDoc.cityTownVillage = cityTownVillage || undefined;

    await reporterDoc.save();
    await updateReporterSubmissionIdentity(reporterDoc, reporterDoc.email || reporterDoc.emailLower, reporterDoc.fullName);
    await logReporterActivity('reporter_portal_profile_updated', req.reporterPortal.email, { ip: getClientIp(req), reporterId: String(reporterDoc._id) });

    return res.status(200).json({ ok: true, profile: mapReporterProfile(reporterDoc) });
  } catch (error) {
    console.error('[reporter-portal][profile-update] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'PROFILE_UPDATE_FAILED', message: 'Failed to update profile.' });
  }
});

router.post('/profile/email/request-change', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const reporterDoc = req._reporterPortalDoc || await ReporterContact.findById(req.reporterPortal.reporterId);
    if (!reporterDoc) {
      return res.status(404).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }

    const nextEmail = normalizeEmail(req.body && req.body.email);
    if (!nextEmail) {
      return res.status(400).json({ ok: false, code: 'EMAIL_REQUIRED', message: 'Email is required.' });
    }

    const currentEmail = normalizeEmail(reporterDoc.email || reporterDoc.emailLower);
    if (nextEmail === currentEmail) {
      return res.status(400).json({ ok: false, code: 'EMAIL_UNCHANGED', message: 'New email must be different from current email.' });
    }

    const requestLimitKey = getRateLimitKey(req, `email-change:${nextEmail}`);
    const requestLimit = consumeRateLimit(otpRequestAttempts, requestLimitKey, OTP_REQUEST_RATE_LIMIT);
    if (requestLimit.limited) {
      await logReporterActivity('reporter_portal_email_change_rate_limited', currentEmail, { ip: getClientIp(req), nextEmail });
      return res.status(429).json({ ok: false, code: 'OTP_REQUEST_RATE_LIMITED', message: 'Too many OTP requests. Please try again later.' });
    }

    const existing = await ReporterContact.findOne({ $or: [{ email: nextEmail }, { emailLower: nextEmail }] });
    if (existing && String(existing._id) !== String(reporterDoc._id)) {
      return res.status(409).json({ ok: false, code: 'EMAIL_ALREADY_IN_USE', message: 'That email is already linked to another reporter account.' });
    }

    await OtpToken.updateMany(
      { email: nextEmail, purpose: REPORTER_PORTAL_EMAIL_CHANGE_OTP_PURPOSE, used: false },
      { $set: { used: true } }
    );

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
    const codeHash = await bcrypt.hash(code, 10);
    await OtpToken.create({ email: nextEmail, purpose: REPORTER_PORTAL_EMAIL_CHANGE_OTP_PURPOSE, codeHash, expiresAt, used: false });

    reporterDoc.pendingPortalEmail = nextEmail;
    reporterDoc.pendingPortalEmailRequestedAt = new Date();
    await reporterDoc.save();
    await sendReporterOtpEmail(nextEmail, code);
    await logReporterActivity('reporter_portal_email_change_requested', currentEmail, { ip: getClientIp(req), nextEmail, reporterId: String(reporterDoc._id) });

    return res.status(200).json({
      ok: true,
      emailMasked: maskEmail(nextEmail),
      message: 'Verification code sent to the new email address.',
      ...((process.env.NODE_ENV === 'test' || String(process.env.OTP_DEV_ECHO || '') === '1') ? { devCode: code } : {}),
    });
  } catch (error) {
    console.error('[reporter-portal][profile-email-request] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'EMAIL_CHANGE_REQUEST_FAILED', message: 'Failed to start email change verification.' });
  }
});

router.post('/profile/email/confirm-change', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const reporterDoc = req._reporterPortalDoc || await ReporterContact.findById(req.reporterPortal.reporterId);
    if (!reporterDoc) {
      return res.status(404).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }

    const nextEmail = normalizeEmail(req.body && req.body.email);
    const otp = String(req.body && (req.body.otp || req.body.code) || '').trim();
    if (!nextEmail || !otp) {
      return res.status(400).json({ ok: false, code: 'OTP_REQUIRED', message: 'Email and OTP are required.' });
    }

    if (normalizeEmail(reporterDoc.pendingPortalEmail) !== nextEmail) {
      return res.status(400).json({ ok: false, code: 'EMAIL_CHANGE_NOT_REQUESTED', message: 'No pending email verification exists for that address.' });
    }

    const verifyLimitKey = getRateLimitKey(req, `email-change:${nextEmail}`);
    const verifyLimit = consumeRateLimit(otpVerifyAttempts, verifyLimitKey, OTP_VERIFY_RATE_LIMIT);
    if (verifyLimit.limited) {
      await logReporterActivity('reporter_portal_email_change_verify_rate_limited', req.reporterPortal.email, { ip: getClientIp(req), nextEmail });
      return res.status(429).json({ ok: false, code: 'OTP_VERIFY_RATE_LIMITED', message: 'Too many verification attempts. Please try again later.' });
    }

    const otpRecord = await OtpToken.findOne({ email: nextEmail, purpose: REPORTER_PORTAL_EMAIL_CHANGE_OTP_PURPOSE, used: false }).sort({ createdAt: -1 });
    if (!otpRecord || !otpRecord.expiresAt || new Date() > new Date(otpRecord.expiresAt)) {
      return res.status(400).json({ ok: false, code: 'INVALID_OTP', message: 'Invalid or expired OTP.' });
    }

    const matches = await bcrypt.compare(otp, otpRecord.codeHash);
    if (!matches) {
      return res.status(400).json({ ok: false, code: 'INVALID_OTP', message: 'Invalid or expired OTP.' });
    }

    clearRateLimit(otpVerifyAttempts, verifyLimitKey);

    otpRecord.used = true;
    if (typeof otpRecord.save === 'function') {
      await otpRecord.save();
    }

    const previousEmail = normalizeEmail(reporterDoc.email || reporterDoc.emailLower);
    reporterDoc.email = nextEmail;
    reporterDoc.emailLower = nextEmail;
    reporterDoc.pendingPortalEmail = null;
    reporterDoc.pendingPortalEmailRequestedAt = null;
    reporterDoc.portalAuthVersion = (typeof reporterDoc.portalAuthVersion === 'number' ? reporterDoc.portalAuthVersion : 0) + 1;
    await reporterDoc.save();

    await updateReporterSubmissionIdentity(reporterDoc, nextEmail, reporterDoc.fullName);
    await logReporterActivity('reporter_portal_email_change_confirmed', previousEmail, { ip: getClientIp(req), nextEmail, reporterId: String(reporterDoc._id) });

    return res.status(200).json({
      ok: true,
      reverifyRequired: true,
      message: 'Email updated successfully. Please login again with the new email.',
      profile: mapReporterProfile(reporterDoc),
    });
  } catch (error) {
    console.error('[reporter-portal][profile-email-confirm] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'EMAIL_CHANGE_CONFIRM_FAILED', message: 'Failed to confirm email change.' });
  }
});

router.get('/auth/session', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const submissions = await loadOwnedSubmissions(req.reporterPortal);
    const { summary } = buildSummary(submissions);
    const expiresAt = req.reporterPortalTokenPayload && req.reporterPortalTokenPayload.exp
      ? new Date(req.reporterPortalTokenPayload.exp * 1000)
      : null;

    return res.status(200).json({
      ok: true,
      reporter: {
        id: req.reporterPortal.reporterId,
        email: req.reporterPortal.email,
        fullName: req.reporterPortal.fullName,
        reporterType: req.reporterPortal.reporterType,
        verificationLevel: req.reporterPortal.verificationLevel,
        status: req.reporterPortal.status,
      },
      session: {
        expiresAt,
      },
      portal: req.reporterPortalState || null,
      summary,
    });
  } catch (error) {
    console.error('[reporter-portal][session] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'SESSION_LOAD_FAILED', message: 'Failed to load reporter session.' });
  }
});

router.get('/dashboard/summary', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const submissions = await loadOwnedSubmissions(req.reporterPortal);
    const { summary } = buildSummary(submissions);
    return res.status(200).json({ ok: true, summary });
  } catch (error) {
    console.error('[reporter-portal][dashboard-summary] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'DASHBOARD_SUMMARY_FAILED', message: 'Failed to load dashboard summary.' });
  }
});

router.get('/submissions/stats', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const submissions = await loadOwnedSubmissions(req.reporterPortal);
    const stats = buildSummary(submissions);
    return res.status(200).json({ ok: true, ...stats });
  } catch (error) {
    console.error('[reporter-portal][submission-stats] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'SUBMISSION_STATS_FAILED', message: 'Failed to load submission stats.' });
  }
});

router.get('/submissions', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query && req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query && req.query.limit || '20', 10), 1), 100);
    const status = String(req.query && req.query.status || '').trim();
    const q = String(req.query && req.query.q || '').trim().toLowerCase();

    const submissions = await loadOwnedSubmissions(req.reporterPortal);
    const filtered = submissions.filter((submission) => {
      if (!matchesPortalStatus(submission.status, status)) return false;
      if (!q) return true;
      const haystack = [submission.headline, submission.body, submission.category, submission.desk, submission.track]
        .map((value) => String(value || '').toLowerCase())
        .join(' ');
      return haystack.includes(q);
    });

    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit).map(mapSubmission);

    return res.status(200).json({
      ok: true,
      items,
      meta: {
        total: filtered.length,
        page,
        limit,
      },
    });
  } catch (error) {
    console.error('[reporter-portal][submissions] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'SUBMISSIONS_LOAD_FAILED', message: 'Failed to load submissions.' });
  }
});

router.get('/submissions/:id', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const id = String(req.params && req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, code: 'INVALID_SUBMISSION_ID', message: 'Invalid submission id.' });
    }

    const filter = buildReporterOwnershipFilter(req.reporterPortal);
    const submission = await CommunitySubmission.findOne({ _id: id, ...filter });
    if (!submission) {
      return res.status(404).json({ ok: false, code: 'SUBMISSION_NOT_FOUND', message: 'Submission not found.' });
    }

    return res.status(200).json({ ok: true, item: mapSubmission(submission) });
  } catch (error) {
    console.error('[reporter-portal][submission-detail] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'SUBMISSION_DETAIL_FAILED', message: 'Failed to load submission detail.' });
  }
});

router.post('/submissions', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const reporterDoc = req._reporterPortalDoc || await ReporterContact.findById(req.reporterPortal.reporterId);
    if (!reporterDoc) {
      return res.status(403).json({ ok: false, code: 'REPORTER_NOT_FOUND', message: 'Reporter account not found.' });
    }

    const status = toStoredStatusForCreate(req.body && req.body.action);
    const headline = String(req.body && req.body.headline || '').trim();
    const story = String(req.body && (req.body.story || req.body.body) || '').trim();

    if (status === 'SUBMITTED' && (!headline || !story)) {
      return res.status(400).json({ ok: false, code: 'VALIDATION_FAILED', message: 'Headline and story are required before submission.' });
    }
    if (status === 'DRAFT' && !headline && !story) {
      return res.status(400).json({ ok: false, code: 'VALIDATION_FAILED', message: 'Draft must contain a headline or story.' });
    }

    const { upsertReporterContactFromPayload } = require('../services/reporterContactService');
    await upsertReporterContactFromPayload({
      name: reporterDoc.fullName,
      email: req.reporterPortal.email,
      phone: req.body && (req.body.phone || req.body.contactPhone),
      city: req.body && (req.body.city || (req.body.location && req.body.location.city)),
      state: req.body && (req.body.state || (req.body.location && req.body.location.state)),
      country: req.body && (req.body.country || (req.body.location && req.body.location.country)),
      reporterType: reporterDoc.reporterType || 'community',
    }).catch(() => null);

    const deskMeta = inferSubmissionDeskMetadata(req.body || {});
    const attachments = extractSubmissionAttachments(req.body || {});
    const submission = await CommunitySubmission.create({
      reporterName: reporterDoc.fullName || 'Reporter',
      reporterEmail: req.reporterPortal.email,
      reporterEmailNorm: req.reporterPortal.email,
      name: reporterDoc.fullName || 'Reporter',
      email: req.reporterPortal.email,
      headline,
      body: story,
      category: String(req.body && req.body.category || '').trim() || (deskMeta.track || null),
      desk: deskMeta.desk || null,
      submissionType: deskMeta.submissionType || null,
      intakeSource: deskMeta.intakeSource || 'reporter_portal',
      track: deskMeta.track || null,
      status,
      reporterId: reporterDoc._id,
      sourceType: reporterDoc.reporterType === 'journalist' ? 'journalist' : 'community',
      reporterVerificationLevel: mapVerificationLevelForSubmission(reporterDoc),
      contact: {
        name: reporterDoc.fullName || 'Reporter',
        email: req.reporterPortal.email,
        phone: String(req.body && (req.body.phone || req.body.contactPhone) || '').trim() || undefined,
      },
      attachments,
      mediaUrl: attachments[0] && attachments[0].url ? attachments[0].url : undefined,
      mediaLink: attachments[0] && attachments[0].url ? attachments[0].url : undefined,
      ipAddress: req.ip ? String(req.ip) : undefined,
      userAgent: req.get('user-agent') ? String(req.get('user-agent')) : undefined,
    });

    applySubmissionPatch(submission, req.body || {}, req.reporterPortal);
    if (typeof submission.save === 'function') {
      await submission.save();
    }

    try {
      const { resolveAndAttachForSubmission } = require('../services/reporterIdentityResolution.service');
      await resolveAndAttachForSubmission(submission, { req });
    } catch (_) {}

    return res.status(201).json({ ok: true, item: mapSubmission(submission) });
  } catch (error) {
    console.error('[reporter-portal][create-submission] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'SUBMISSION_CREATE_FAILED', message: 'Failed to create submission.' });
  }
});

router.patch('/submissions/:id', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const id = String(req.params && req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, code: 'INVALID_SUBMISSION_ID', message: 'Invalid submission id.' });
    }

    const filter = buildReporterOwnershipFilter(req.reporterPortal);
    const submission = await CommunitySubmission.findOne({ _id: id, ...filter });
    if (!submission) {
      return res.status(404).json({ ok: false, code: 'SUBMISSION_NOT_FOUND', message: 'Submission not found.' });
    }

    if (!canEditSubmission(submission)) {
      return res.status(409).json({ ok: false, code: 'SUBMISSION_NOT_EDITABLE', message: 'This submission can no longer be edited.' });
    }

    const nextStatus = toStoredStatusForUpdate(toPortalStatus(submission.status), req.body && req.body.action);
    applySubmissionPatch(submission, req.body || {}, req.reporterPortal);

    if (nextStatus === 'SUBMITTED' && (!String(submission.headline || '').trim() || !String(submission.body || '').trim())) {
      return res.status(400).json({ ok: false, code: 'VALIDATION_FAILED', message: 'Headline and story are required before submission.' });
    }

    if (nextStatus) submission.status = nextStatus;
    submission.reporterId = submission.reporterId || req.reporterPortal.reporterId;
    submission.reporterEmailNorm = submission.reporterEmailNorm || req.reporterPortal.email;

    await submission.save();

    try {
      const { resolveAndAttachForSubmission } = require('../services/reporterIdentityResolution.service');
      await resolveAndAttachForSubmission(submission, { req });
    } catch (_) {}

    return res.status(200).json({ ok: true, item: mapSubmission(submission) });
  } catch (error) {
    console.error('[reporter-portal][update-submission] failed', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, code: 'SUBMISSION_UPDATE_FAILED', message: 'Failed to update submission.' });
  }
});

module.exports = router;