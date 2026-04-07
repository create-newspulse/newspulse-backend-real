const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const mongoose = require('mongoose');
const CommunitySubmission = require('../models/CommunitySubmission');
// Re-use legacy models from nested app for reporter + story linkage
let Reporter = null;
let ReporterStory = null;
try { Reporter = require('../newspulse-backend-real-main/models/Reporter'); } catch (_) {}
try { ReporterStory = require('../newspulse-backend-real-main/models/CommunityStory'); } catch (_) {}
const { runCommunityAiChecks } = require('../services/communityAi');
const {
  COMMUNITY_REPORTER_CATEGORIES,
  extractSubmissionAttachments,
  inferSubmissionDeskMetadata,
  normalizeCommunityReporterCategory,
  normalizeDeskValue,
  normalizeWorkflowStatus,
} = require('../services/communitySubmissionWorkflow');
const { getEffectiveCommunityAccessState } = require('../services/communityAccessToggleService');
// NOTE: Phase-1 /submit handler is implemented inline below for clarity and
// to keep it fully aligned with the public form payload.
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireReporterPortalAuth } = require('../middleware/reporterPortalAuth');

const router = express.Router();

function shouldLogReporterContactPipeline() {
  const enabled = String(process.env.REPORTER_CONTACT_PIPELINE_LOG || '').trim() === '1';
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  return enabled || (env && env !== 'production');
}

function logReporterContactPipeline(payload) {
  if (!shouldLogReporterContactPipeline()) return;
  try {
    console.log('[reporter-contact-pipeline]', payload);
  } catch (_) {}
}
const REPORTER_EMAIL_LOOKUP_FIELDS = [
  'reporterEmailNorm',
  'reporterEmail',
  'email',
  'submittedByEmail',
  'contactEmail',
  'authorEmail',
  'contact.email',
  'reporter.email',
  'reporterProfile.email',
  'contributor.email',
];

async function requireCommunityReporterOpen(req, res, next) {
  try {
    const state = await getEffectiveCommunityAccessState();
    if (state.communityReporterClosed) {
      return res.status(503).json({
        ok: false,
        code: 'COMMUNITY_REPORTER_CLOSED',
        message: 'Community Reporter is currently closed.',
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

async function requireReporterPortalOpen(req, res, next) {
  try {
    const state = await getEffectiveCommunityAccessState();
    if (state.reporterPortalClosed) {
      return res.status(503).json({
        ok: false,
        code: 'REPORTER_PORTAL_CLOSED',
        message: 'Reporter Portal is currently closed.',
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

function buildReporterPortalOwnershipFilter(reporter) {
  const email = String(reporter && reporter.email || '').trim().toLowerCase();
  const clauses = [];
  const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (reporter && reporter.reporterId && mongoose.isValidObjectId(String(reporter.reporterId))) {
    clauses.push({ reporterId: reporter.reporterId });
  }
  if (email) {
    const caseInsensitive = new RegExp(`^${escapeRegex(email)}$`, 'i');
    for (const field of REPORTER_EMAIL_LOOKUP_FIELDS) {
      clauses.push({ [field]: email });
      if (field !== 'reporterEmailNorm') {
        clauses.push({ [field]: caseInsensitive });
      }
    }
  }
  return {
    isDeleted: { $ne: true },
    ...(clauses.length ? { $or: clauses } : {}),
  };
}

function _parseMaxUploadBytes() {
  const rawMb = process.env.COMMUNITY_REPORTER_MAX_UPLOAD_MB;
  const mb = Number(rawMb);
  const safeMb = Number.isFinite(mb) && mb > 0 ? mb : 5;
  return Math.floor(safeMb * 1024 * 1024);
}

function _resolveUploadDir() {
  const root = path.join(__dirname, '..');
  const dirFromEnv = (process.env.COMMUNITY_REPORTER_UPLOAD_DIR || 'uploads/community-reporter-ids').trim();
  const abs = path.isAbsolute(dirFromEnv) ? dirFromEnv : path.join(root, dirFromEnv);
  return { root, abs, dirFromEnv };
}

function _safeOriginalName(name) {
  const base = path.basename(String(name || '')).replace(/[\r\n\t]/g, ' ').trim();
  if (!base) return 'file';
  return base.length > 180 ? base.slice(0, 180) : base;
}

function _generateFileId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

const _allowedMimeToExt = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
};

function _publicUrlOrPathForStoredFile(root, absUploadDir, filename) {
  const uploadsRoot = path.join(root, 'uploads');
  const normalizedUploadsRoot = path.normalize(uploadsRoot + path.sep);
  const normalizedAbsDir = path.normalize(absUploadDir + path.sep);

  if (normalizedAbsDir.startsWith(normalizedUploadsRoot)) {
    const relDir = path.relative(uploadsRoot, absUploadDir).split(path.sep).filter(Boolean).join('/');
    const safeFile = encodeURIComponent(path.basename(String(filename || '')));
    const url = relDir ? `/uploads/${relDir}/${safeFile}` : `/uploads/${safeFile}`;
    return { url };
  }

  return { path: path.join(absUploadDir, path.basename(String(filename || ''))) };
}

const _communityReporterIdUpload = (() => {
  const { root, abs } = _resolveUploadDir();
  const maxBytes = _parseMaxUploadBytes();

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      try { fs.mkdirSync(abs, { recursive: true }); } catch (_) {}
      cb(null, abs);
    },
    filename: (req, file, cb) => {
      const ext = _allowedMimeToExt[String(file.mimetype || '').toLowerCase()] || 'bin';
      const fileId = req._communityReporterIdFileId || _generateFileId();
      req._communityReporterIdFileId = fileId;
      cb(null, `${fileId}.${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: maxBytes },
    fileFilter: (req, file, cb) => {
      const mime = String(file.mimetype || '').toLowerCase();
      if (!_allowedMimeToExt[mime]) {
        const err = new Error('INVALID_FILE_TYPE');
        err.code = 'INVALID_FILE_TYPE';
        return cb(err);
      }
      // Stash a fileId early so it exists even if we later add other metadata.
      req._communityReporterIdFileId = req._communityReporterIdFileId || _generateFileId();
      return cb(null, true);
    },
  });

  return {
    handler(req, res) {
      upload.single('file')(req, res, (err) => {
        try {
          if (err) {
            const code = err.code || err.message;
            const meta = {
              code,
              message: err.message,
              email: req.body && req.body.email ? String(req.body.email).slice(0, 120) : undefined,
              reporterId: req.body && req.body.reporterId ? String(req.body.reporterId).slice(0, 80) : undefined,
            };
            console.error('[COMMUNITY_REPORTER][upload-id] failed', meta);

            if (code === 'LIMIT_FILE_SIZE') {
              return res.status(413).json({ ok: false, message: 'FILE_TOO_LARGE' });
            }
            if (code === 'INVALID_FILE_TYPE') {
              return res.status(400).json({ ok: false, message: 'INVALID_FILE_TYPE' });
            }
            if (code === 'LIMIT_UNEXPECTED_FILE') {
              return res.status(400).json({ ok: false, message: 'UNEXPECTED_FILE_FIELD' });
            }

            return res.status(400).json({ ok: false, message: 'UPLOAD_FAILED' });
          }

          if (!req.file) {
            return res.status(400).json({ ok: false, message: 'FILE_REQUIRED' });
          }

          const { root, abs: absUploadDir } = _resolveUploadDir();
          const file = req.file;
          const fileId = req._communityReporterIdFileId || _generateFileId();
          const originalName = _safeOriginalName(file.originalname);
          const location = _publicUrlOrPathForStoredFile(root, absUploadDir, file.filename);

          const payload = {
            ok: true,
            fileId,
            mime: file.mimetype,
            size: file.size,
            originalName,
            ...location,
          };

          return res.status(201).json(payload);
        } catch (e) {
          console.error('[COMMUNITY_REPORTER][upload-id] error', e?.message || e);
          return res.status(500).json({ ok: false, message: 'UPLOAD_FAILED' });
        }
      });
    },
  };
})();

// POST /api/community-reporter/upload-id
// multipart/form-data: file (required), email (optional), reporterId (optional), note (optional)
router.post('/upload-id', requireCommunityReporterOpen, (req, res) => _communityReporterIdUpload.handler(req, res));

// POST /api/public/community-reporter/:id/withdraw
router.post('/:id/withdraw', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id || !/^[a-fA-F0-9]{24}$/.test(String(id))) {
      return res.status(400).json({ ok: false, message: 'Invalid story id' });
    }
    const ownershipFilter = buildReporterPortalOwnershipFilter(req.reporterPortal);
    const story = await CommunitySubmission.findOne({ _id: id, ...ownershipFilter });
    if (!story) return res.status(404).json({ ok: false, message: 'Story not found' });
    const status = String(story.status || '').toLowerCase();
    if (!['under_review','pending','new','pending_founder'].includes(status)) {
      return res.status(400).json({ ok: false, message: 'You can withdraw only while the story is under review.' });
    }
    story.status = 'withdrawn';
    try { story.withdrawnAt = new Date(); } catch (_) {}
    await story.save();
    return res.json({ ok: true });
  } catch (e) {
    console.error('[COMMUNITY_REPORTER][withdraw-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to withdraw story' });
  }
});

// Map internal status -> external Phase 1 label
function externalStatus(internal) {
  switch (internal) {
    case 'NEW': return 'pending';
    case 'APPROVED': return 'approved';
    case 'REJECTED': return 'rejected';
    default: return 'pending';
  }
}

// POST /api/community-reporter/submissions (public, no auth)
router.post('/submissions', requireCommunityReporterOpen, async (req, res) => {
  try {
    const body = req.body || {};
    const deskMeta = inferSubmissionDeskMetadata(body);
    const {
      name,
      fullName,
      email,
      location,
      category,
      headline,
      story,
      phone,
      city,
      state,
      country,
      contactEmail,
      contactPhone,
      title,
      content,
      track,
      desk,
      submissionType,
      intakeSource,
      preferredLanguages,
      heardAbout,
      isProfessionalJournalist,
      communityInterests,
      organisationName,
      organisationType,
      positionTitle,
      beatsProfessional,
      yearsExperience,
      websiteOrPortfolio,
      socialLinks,
      journalistCharterAccepted,
    } = body;
    const errors = [];
    if (!(name || fullName) || !String(name || fullName).trim()) errors.push('name required');
    if (!email || !String(email).trim()) errors.push('email required');
    if (!location && !city && !state) errors.push('location required');
    if (!(category || track || deskMeta.track)) errors.push('category required');
    if (!(headline || title) || !String(headline || title).trim()) errors.push('headline required');
    if (!(story || content) || !String(story || content).trim()) errors.push('story required');
    if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });

    const normalizedCategory = normalizeCommunityReporterCategory(category || track || null);
    if (!normalizedCategory) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: [`category must be one of: ${COMMUNITY_REPORTER_CATEGORIES.join(', ')}`],
      });
    }

    // Parse location string ("City, State, Country") when frontend sends a single text field.
    const locationText = (typeof location === 'string') ? String(location).trim() : '';
    const locationParts = locationText
      ? locationText.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const locationCityFromText = locationParts[0] || null;
    const locationStateFromText = locationParts[1] || null;
    const locationCountryFromText = locationParts[2] || null;

    // Upsert reporter contact (community type)
    const { upsertReporterContactFromPayload } = require('../services/reporterContactService');
    let reporterResult = null;
    try {
      const reporterType = isProfessionalJournalist ? 'journalist' : 'community';
      reporterResult = await upsertReporterContactFromPayload({
        name: (fullName || name || '').trim(),
        email: email.trim().toLowerCase(),
        phone: phone || contactPhone,
        city: (city || locationCityFromText || '').trim(),
        state: (state || locationStateFromText || '').trim(),
        country: (country || locationCountryFromText || '').trim(),
        reporterType,
        stats: {
          lastStoryAt: new Date(),
          lastStoryTitle: (headline || '').trim(),
        },
        languages: Array.isArray(preferredLanguages) ? preferredLanguages : undefined,
        interests: Array.isArray(communityInterests) ? communityInterests : undefined,
        heardAbout,
        organisationName,
        organisationType,
        positionTitle,
        beatsProfessional,
        yearsExperience,
        websiteOrPortfolio,
        socialLinks,
        journalistCharterAccepted,
      });
    } catch (err) {
      console.error('[COMMUNITY_REPORTER][contact-upsert-failed]', err?.message || err);
      // Continue without reporterContact (fallback legacy behavior)
    }

    const cityNorm = (city || locationCityFromText || locationText || '').trim();
    const stateNorm = (state || locationStateFromText || '').trim();
    const countryNorm = (country || locationCountryFromText || '').trim();
    const attachments = extractSubmissionAttachments(body);
    const normalizedHeadline = (headline || title || '').trim();
    const normalizedStory = (story || content || '').trim();
    // Log reporter email used for saving
    console.log('[COMMUNITY_REPORTER][create] saving submission for reporterEmail:', (email || '').trim().toLowerCase());
    const submission = await CommunitySubmission.create({
      // Required duplicates for model
      reporterName: (fullName || name || '').trim(),
      reporterEmail: (email || '').trim().toLowerCase(),
      // Legacy/alias fields for compatibility
      name: (name || '').trim(),
      email: (email || '').trim().toLowerCase(),
      category: normalizedCategory,
      desk: deskMeta.desk || normalizeDeskValue(desk) || undefined,
      submissionType: deskMeta.submissionType || (submissionType ? String(submissionType).trim().toLowerCase() : undefined),
      intakeSource: deskMeta.intakeSource || (intakeSource ? String(intakeSource).trim().toLowerCase() : undefined),
      track: deskMeta.track || undefined,
      headline: normalizedHeadline,
      body: normalizedStory,
      // Normalized location object expected by schema
      location: { city: cityNorm || null, state: stateNorm || null, country: countryNorm || null },
      reporterLocation: cityNorm || undefined,
      city: cityNorm || undefined,
      state: stateNorm || undefined,
      country: countryNorm || undefined,
      contact: {
        name: (fullName || name || '').trim() || undefined,
        email: (contactEmail || email || '').trim().toLowerCase() || undefined,
        phone: (contactPhone || phone || '').trim() || undefined,
      },
      attachments,
      mediaUrl: (attachments[0] && attachments[0].url) || undefined,
      mediaLink: (attachments[0] && attachments[0].url) || undefined,
      // Defaults
      status: deskMeta.isYouthPulse ? 'NEW' : 'PENDING_FOUNDER',
      reporterId: reporterResult ? reporterResult.contactId : undefined,
      sourceType: reporterResult ? (reporterResult.contact.reporterType === 'journalist' ? 'journalist' : 'community') : (isProfessionalJournalist ? 'journalist' : 'community'),
      reporterVerificationLevel: (function () {
        if (!reporterResult || !reporterResult.contact || !reporterResult.contact.verificationLevel) return 'unverified';
        const v = reporterResult.contact.verificationLevel;
        if (v === 'verified') return 'journalist_verified';
        if (v === 'pending') return 'journalist_pending';
        return 'unverified';
      })(),
    });

    // Contributor network linkage (best-effort; never blocks submission)
    try {
      const { resolveAndAttachForSubmission } = require('../services/reporterIdentityResolution.service');
      await resolveAndAttachForSubmission(submission, { req });
    } catch (_) {}
    if (process.env.NODE_ENV !== 'test') {
      try {
        await runCommunityAiChecks(submission);
      } catch (err) {
        console.error('[CommunityAI] Failed to process reporter submission', err?.message || err);
        submission.status = 'PENDING_FOUNDER';
        try { await submission.save(); } catch (_) {}
      }
    }
    return res.status(201).json({ success: true, item: {
      id: submission._id.toString(),
      name: submission.name,
      email: submission.email,
      location: submission.location,
      category: submission.category,
      desk: submission.desk || null,
      track: submission.track || null,
      submissionType: submission.submissionType || null,
      intakeSource: submission.intakeSource || null,
      attachments: Array.isArray(submission.attachments) ? submission.attachments : [],
      headline: submission.headline,
      story: submission.body,
      aiHeadline: submission.aiHeadline,
      aiBody: submission.aiBody,
      riskScore: submission.riskScore,
      flags: submission.flags,
      status: externalStatus(submission.status),
      reporterId: submission.reporterId ? String(submission.reporterId) : null,
      sourceType: submission.sourceType,
      reporterVerificationLevel: submission.reporterVerificationLevel,
      createdAt: submission.createdAt,
    }});
  } catch (e) {
    console.error('[COMMUNITY_REPORTER][create-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Server error creating submission' });
  }
});

// Secure alias for older frontend integrations. Requires verified reporter portal auth.
router.get('/my-stories', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const docs = await CommunitySubmission
      .find(buildReporterPortalOwnershipFilter(req.reporterPortal))
      .sort({ createdAt: -1 })
      .lean();

    const items = docs.map(s => {
      const emailOut = (s.reporterEmailNorm || s.reporterEmail || s.email || (s.contact && s.contact.email) || null);
      const nameOut = (s.reporterName || s.name || (s.contact && s.contact.name) || null);
      const rawLocation = s.reporterLocation || null;
      const locObj = s.location || s.locationDetail || null;
      const city = (locObj && locObj.city) || s.city || rawLocation || null;
      const locationText = rawLocation || (typeof city === 'string' ? city : null);

      return {
        id: String(s._id),
        headline: s.headline || '',
        story: s.body || '',
        ageGroup: s.ageGroup || null,
        status: s.status || 'NEW',
        name: nameOut,
        email: emailOut,
        location: locationText,
        locationObj: locObj,
        createdAt: s.createdAt || null,
        updatedAt: s.updatedAt || null,
      };
    });

    return res.status(200).json({
      success: true,
      items,
      total: items.length,
      // Backward compatibility
      ok: true,
      stories: items,
      submissions: items,
    });
  } catch (error) {
    console.error('CommunityReporter my-stories error:', error);
    return res.status(500).json({ message: 'Internal error in Community Reporter my stories' });
  }
});

// Secure alias for older frontend integrations. Requires verified reporter portal auth.
router.get('/reporter-stories', requireReporterPortalOpen, requireReporterPortalAuth, async (req, res) => {
  try {
    const { status } = req.query || {};
    const filter = buildReporterPortalOwnershipFilter(req.reporterPortal);

    if (status && status !== 'all') {
      filter.status = status;
    }

    const stories = await CommunitySubmission
      .find(filter)
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ ok: true, stories });
  } catch (err) {
    console.error('Error in GET /reporter-stories', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// Phase 1 endpoints (public): submit + list by email
// POST /api/community-reporter/submit
router.post('/submit', requireCommunityReporterOpen, async (req, res) => {
  try {
    const body = req.body || {};
    const deskMeta = inferSubmissionDeskMetadata(body);
    const { name, email, location, headline, title, story, content, ageGroup } = body;

    if (!name || !email || !(headline || title) || !(story || content) || !ageGroup) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const nameNorm = String(name).trim();
    const emailNorm = String(email).trim().toLowerCase();
    const headlineNorm = String(headline || title).trim();
    const storyNorm = String(story || content).trim();
    const ageGroupNorm = String(ageGroup).trim();
    const normalizedCategory = normalizeCommunityReporterCategory(body.category || body.track || null);
    const attachments = extractSubmissionAttachments(body);

    if (!normalizedCategory) {
      return res.status(400).json({
        message: `Category must be one of: ${COMMUNITY_REPORTER_CATEGORIES.join(', ')}`,
      });
    }

    const locationObj = (location && typeof location === 'object') ? location : null;
    const locationText = (typeof location === 'string') ? location.trim() : undefined;

    // Parse "City, State, Country" if location comes as a string.
    let parsedCity = null;
    let parsedState = null;
    let parsedCountry = null;
    if (locationText) {
      const parts = locationText.split(',').map(s => s.trim()).filter(Boolean);
      parsedCity = parts[0] || null;
      parsedState = parts[1] || null;
      parsedCountry = parts[2] || null;
    }

    // Best-effort: upsert contact directory (do not block submit flow)
    const { upsertReporterContactFromPayload, upsertReporterContactFromSubmission } = require('../services/reporterContactService');
    let reporterResult = null;
    try {
      logReporterContactPipeline({
        stage: 'community.submit.incoming',
        email: emailNorm,
        incomingPhone: req.body && (req.body.phone || req.body.phoneNumber || req.body.mobile || req.body.mobileNumber || req.body.contactNumber || null),
        incomingWhatsapp: req.body && (req.body.whatsapp || req.body.whatsappNumber || null),
        incomingCity: locationObj?.city || parsedCity || null,
        incomingDistrict: (locationObj && locationObj.district) || req.body?.district || null,
        incomingState: locationObj?.state || parsedState || null,
        incomingCountry: locationObj?.country || parsedCountry || null,
        incomingBeat: req.body?.beat || req.body?.primaryBeat || null,
        incomingArea: req.body?.area || (locationObj && locationObj.area) || null,
        incomingAreaType: req.body?.areaType || null,
        incomingCoverageScope: req.body?.coverageScope || null,
        incomingOrganisation: req.body?.organisationName || req.body?.organizationName || req.body?.organization || null,
        reporterContactId: null,
      });
      reporterResult = await upsertReporterContactFromPayload({
        name: nameNorm,
        email: emailNorm,
        phone: (req.body && (req.body.phone || req.body.phoneNumber || req.body.mobile || req.body.mobileNumber || req.body.contactNumber)) || undefined,
        whatsapp: (req.body && (req.body.whatsapp || req.body.whatsappNumber)) || undefined,
        city: locationObj?.city || parsedCity || undefined,
        district: (locationObj && locationObj.district) || req.body?.district || undefined,
        state: locationObj?.state || parsedState || undefined,
        country: locationObj?.country || parsedCountry || undefined,
        beat: req.body?.beat || req.body?.primaryBeat || undefined,
        area: req.body?.area || (locationObj && locationObj.area) || undefined,
        areaType: req.body?.areaType || undefined,
        coverageScope: req.body?.coverageScope || undefined,
        organisationName: req.body?.organisationName || req.body?.organizationName || req.body?.organization || undefined,
        reporterType: 'community',
        stats: {
          lastStoryAt: new Date(),
          lastStoryTitle: headlineNorm,
        },
      });
    } catch (err) {
      console.error('ReporterContact upsert error:', err?.message || err);
    }

    const submission = await CommunitySubmission.create({
      name: nameNorm,
      email: emailNorm,
      reporterName: nameNorm,
      reporterEmail: emailNorm,
      reporterLocation: locationText,
      location: locationObj ? {
        city: locationObj.city ?? null,
        state: locationObj.state ?? null,
        country: locationObj.country ?? null,
      } : (locationText ? { city: parsedCity || locationText || null, state: parsedState || null, country: parsedCountry || null } : { city: null, state: null, country: null }),
      desk: deskMeta.desk || undefined,
      submissionType: deskMeta.submissionType || undefined,
      intakeSource: deskMeta.intakeSource || undefined,
      track: deskMeta.track || undefined,
      category: normalizedCategory,
      headline: headlineNorm,
      story: storyNorm,
      ageGroup: ageGroupNorm,
      status: deskMeta.isYouthPulse ? 'NEW' : 'NEW',
      sourceType: 'community',
      reporterVerificationLevel: 'unverified',
      reporterId: reporterResult ? reporterResult.contactId : undefined,
      phone: (body.phone || body.phoneNumber || body.mobile || body.mobileNumber || body.contactNumber || '').trim() || undefined,
      phoneNumber: (body.phone || body.phoneNumber || body.mobile || body.mobileNumber || body.contactNumber || '').trim() || undefined,
      mobile: (body.mobile || body.mobileNumber || '').trim() || undefined,
      mobileNumber: (body.mobileNumber || body.mobile || '').trim() || undefined,
      contactNumber: (body.contactNumber || body.phone || body.phoneNumber || '').trim() || undefined,
      whatsapp: (body.whatsapp || body.whatsappNumber || '').trim() || undefined,
      whatsappNumber: (body.whatsapp || body.whatsappNumber || '').trim() || undefined,
      city: (locationObj?.city || parsedCity || '').trim() || undefined,
      district: ((locationObj && locationObj.district) || body.district || '').trim() || undefined,
      state: (locationObj?.state || parsedState || '').trim() || undefined,
      country: (locationObj?.country || parsedCountry || '').trim() || undefined,
      area: ((locationObj && locationObj.area) || body.area || '').trim() || undefined,
      areaType: String(body.areaType || '').trim() || undefined,
      coverageScope: String(body.coverageScope || '').trim() || undefined,
      beat: String(body.beat || body.primaryBeat || '').trim() || undefined,
      organisationName: String(body.organisationName || body.organizationName || body.organization || '').trim() || undefined,
      organisationType: String(body.organisationType || body.organizationType || '').trim() || undefined,
      contact: {
        name: nameNorm,
        email: emailNorm,
        phone: (body.phone || body.contactPhone || '').trim() || undefined,
        whatsappNumber: (body.whatsapp || body.whatsappNumber || '').trim() || undefined,
      },
      locationDetail: {
        city: locationObj?.city || parsedCity || null,
        district: (locationObj && locationObj.district) || body.district || null,
        state: locationObj?.state || parsedState || null,
        country: locationObj?.country || parsedCountry || null,
      },
      attachments,
      mediaUrl: (attachments[0] && attachments[0].url) || undefined,
      mediaLink: (attachments[0] && attachments[0].url) || undefined,
      ipAddress: req.ip ? String(req.ip) : undefined,
      userAgent: req.get('user-agent') ? String(req.get('user-agent')) : undefined,
    });

    logReporterContactPipeline({
      stage: 'community.submit.stored-submission',
      email: submission.reporterEmailNorm || submission.reporterEmail || submission.email || null,
      incomingPhone: req.body && (req.body.phone || req.body.phoneNumber || req.body.mobile || req.body.mobileNumber || req.body.contactNumber || null),
      incomingWhatsapp: req.body && (req.body.whatsapp || req.body.whatsappNumber || null),
      storedPhone: submission.phone || submission.phoneNumber || submission.mobile || submission.mobileNumber || submission.contactNumber || submission.contact?.phone || null,
      storedWhatsapp: submission.whatsapp || submission.whatsappNumber || submission.contact?.whatsappNumber || null,
      storedCity: submission.city || submission.location?.city || submission.locationDetail?.city || null,
      storedDistrict: submission.district || submission.locationDetail?.district || null,
      storedState: submission.state || submission.location?.state || submission.locationDetail?.state || null,
      storedCountry: submission.country || submission.location?.country || submission.locationDetail?.country || null,
      storedArea: submission.area || null,
      storedAreaType: submission.areaType || null,
      storedCoverageScope: submission.coverageScope || null,
      storedBeat: submission.beat || null,
      storedOrganisation: submission.organisationName || null,
      reporterContactId: reporterResult && reporterResult.contactId ? String(reporterResult.contactId) : null,
    });

    // Contributor network linkage (best-effort; never blocks submission)
    try {
      const { resolveAndAttachForSubmission } = require('../services/reporterIdentityResolution.service');
      await resolveAndAttachForSubmission(submission, { req });
    } catch (_) {}

    // Optional second-pass upsert from saved submission (fills counts/latest more accurately).
    try {
      await upsertReporterContactFromSubmission(submission);
    } catch (err) {
      console.error('ReporterContact upsert error:', err?.message || err);
    }

    return res.status(201).json({
      success: true,
      id: submission._id && typeof submission._id.toString === 'function' ? submission._id.toString() : submission._id,
      desk: submission.desk || null,
      track: submission.track || null,
      status: submission.status || null,
    });
  } catch (error) {
    console.error('CommunityReporterSubmit error:', error);
    // Surface validation errors as 400s to avoid noisy 500s for bad payloads.
    if (error && (error.name === 'ValidationError' || error.code === 11000)) {
      return res.status(400).json({ message: 'Invalid submission payload' });
    }
    return res.status(500).json({ message: 'Internal error in Community Reporter submit' });
  }
});
// Keep legacy handler exported but our above inline endpoint returns desired shape
// router.get('/my-stories', listMyCommunityReports);

// Note: queue endpoint temporarily served publicly via app-level route in server.js

module.exports = router;