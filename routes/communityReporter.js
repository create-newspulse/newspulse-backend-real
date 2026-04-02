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
  extractSubmissionAttachments,
  inferSubmissionDeskMetadata,
  normalizeDeskValue,
  normalizeWorkflowStatus,
} = require('../services/communitySubmissionWorkflow');
// NOTE: Phase-1 /submit handler is implemented inline below for clarity and
// to keep it fully aligned with the public form payload.
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

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
router.post('/upload-id', (req, res) => _communityReporterIdUpload.handler(req, res));

// POST /api/public/community-reporter/:id/withdraw
router.post('/:id/withdraw', async (req, res) => {
  try {
    const { id } = req.params || {};
    const { reporterId } = req.body || {};
    if (!id || !/^[a-fA-F0-9]{24}$/.test(String(id))) {
      return res.status(400).json({ ok: false, message: 'Invalid story id' });
    }
    const story = await CommunitySubmission.findById(id);
    if (!story) return res.status(404).json({ ok: false, message: 'Story not found' });
    if (reporterId && story.reporterId && String(story.reporterId) !== String(reporterId)) {
      return res.status(403).json({ ok: false, message: 'Not your story' });
    }
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
router.post('/submissions', async (req, res) => {
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
    const normalizedCategory = (category || track || deskMeta.track || '').trim();
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

// Public API: list community reporter stories by email for “My Community Stories” page.
// GET /api/community-reporter/my-stories?email=...
// Returns a safe public listing filtered by normalized reporter email
router.get('/my-stories', async (req, res) => {
  try {
    const emailQuery = req.query && req.query.email;
    const email = String(emailQuery || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    // In local/test runs without MongoDB, avoid Mongoose command buffering delays.
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      return res.status(200).json({ success: true, items: [], total: 0, stories: [], submissions: [], message: 'Database unavailable' });
    }

    // Primary: Phase-1 schema stores email at the top-level `email`.
    // Fallback: support legacy docs that stored reporterEmail/contact.email.
    const docs = await CommunitySubmission
      .find({
        $or: [
          { email },
          { reporterEmailNorm: email },
          { reporterEmail: email },
          { 'contact.email': email },
        ],
        isDeleted: { $ne: true },
      })
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

// Generic stories listing supporting optional ?email= and ?status=
// GET /api/community-reporter/reporter-stories?email=foo@example.com&status=pending
router.get('/reporter-stories', async (req, res) => {
  try {
    const { email, status } = req.query || {};
    const filter = {};

    if (email) {
      const normalized = String(email).trim().toLowerCase();
      if (normalized) {
        filter.$or = [
          { reporterEmail: normalized },
          { email: normalized },
          { 'contact.email': normalized },
        ];
      }
    }

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
router.post('/submit', async (req, res) => {
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
    const attachments = extractSubmissionAttachments(body);

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
      reporterResult = await upsertReporterContactFromPayload({
        name: nameNorm,
        email: emailNorm,
        phone: (req.body && (req.body.phone || req.body.whatsapp)) || undefined,
        city: locationObj?.city || parsedCity || undefined,
        state: locationObj?.state || parsedState || undefined,
        country: locationObj?.country || parsedCountry || undefined,
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
      category: (body.category || body.track || deskMeta.track || '').trim() || undefined,
      headline: headlineNorm,
      story: storyNorm,
      ageGroup: ageGroupNorm,
      status: deskMeta.isYouthPulse ? 'NEW' : 'NEW',
      sourceType: 'community',
      reporterVerificationLevel: 'unverified',
      reporterId: reporterResult ? reporterResult.contactId : undefined,
      contact: {
        name: nameNorm,
        email: emailNorm,
        phone: (body.phone || body.contactPhone || '').trim() || undefined,
      },
      attachments,
      mediaUrl: (attachments[0] && attachments[0].url) || undefined,
      mediaLink: (attachments[0] && attachments[0].url) || undefined,
      ipAddress: req.ip ? String(req.ip) : undefined,
      userAgent: req.get('user-agent') ? String(req.get('user-agent')) : undefined,
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