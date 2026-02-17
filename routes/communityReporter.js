const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const CommunitySubmission = require('../models/CommunitySubmission');
// Re-use legacy models from nested app for reporter + story linkage
let Reporter = null;
let ReporterStory = null;
try { Reporter = require('../newspulse-backend-real-main/models/Reporter'); } catch (_) {}
try { ReporterStory = require('../newspulse-backend-real-main/models/CommunityStory'); } catch (_) {}
const { runCommunityAiChecks } = require('../services/communityAi');
const { submitCommunityReport, listMyCommunityReports } = require('../controllers/communityReporterController');
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
    const {
      name,
      fullName,
      email,
      location,
      headline,
      story,
      ageGroup,
      category,
      phone,
      city,
      state,
      country,
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
    if (!name || !String(name).trim()) errors.push('name required');
    if (!email || !String(email).trim()) errors.push('email required');
    if (!headline || !String(headline).trim()) errors.push('headline required');
    if (!story || !String(story).trim()) errors.push('story required');
    if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });

    // Upsert reporter contact (community type)
    const { upsertReporterContactFromPayload } = require('../services/reporterContactService');
    let reporterResult = null;
    try {
      const reporterType = isProfessionalJournalist ? 'journalist' : 'community';
      reporterResult = await upsertReporterContactFromPayload({
        name: (fullName || name || '').trim(),
        email: email.trim().toLowerCase(),
        phone: phone,
        city: (city || location || '').trim(),
        state: state,
        country: country,
        reporterType,
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

    const cityNorm = (city || location || '').trim();
    const stateNorm = (state || '').trim();
    const countryNorm = (country || '').trim();
    // Log reporter email used for saving
    console.log('[COMMUNITY_REPORTER][create] saving submission for reporterEmail:', (email || '').trim().toLowerCase());
    const submission = await CommunitySubmission.create({
      // Required duplicates for model
      reporterName: (fullName || name || '').trim(),
      reporterEmail: (email || '').trim().toLowerCase(),
      // Legacy/alias fields for compatibility
      name: (name || '').trim(),
      email: (email || '').trim().toLowerCase(),
      ageGroup: (ageGroup === undefined || ageGroup === null) ? undefined : String(ageGroup).trim(),
      category: (category ? String(category).trim() : 'community'),
      headline: (headline || '').trim(),
      body: (story || '').trim(), // underlying field
      // Normalized location object expected by schema
      location: { city: cityNorm || null, state: stateNorm || null, country: countryNorm || null },
      reporterLocation: cityNorm || undefined,
      city: cityNorm || undefined,
      state: stateNorm || undefined,
      country: countryNorm || undefined,
      // Defaults
      status: 'PENDING_FOUNDER',
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
      headline: submission.headline,
      story: submission.body,
      aiHeadline: submission.aiHeadline,
      aiBody: submission.aiBody,
      riskScore: submission.riskScore,
      flags: submission.flags,
      status: externalStatus(submission.status),
      reporterId: submission.reporterId || null,
      sourceType: submission.sourceType,
      reporterVerificationLevel: submission.reporterVerificationLevel,
      createdAt: submission.createdAt,
    }});
  } catch (e) {
    console.error('[COMMUNITY_REPORTER][create-error]', e);
    return res.status(500).json({ success: false, message: 'Server error creating submission' });
  }
});

// Public API: list community reporter stories by email for “My Community Stories” page.
// GET /api/community-reporter/my-stories?email=...
// Returns a safe public listing filtered by normalized reporter email
router.get('/my-stories', async (req, res) => {
  try {
    const emailParam = req.query && req.query.email;
    const rawEmail = String(emailParam || '').trim();
    if (!rawEmail) {
      return res.status(400).json({ ok: false, message: 'email is required' });
    }

    const normalizedEmail = rawEmail.toLowerCase();

    // Prefer normalized reporterEmailNorm lookups, with fallback for legacy docs
    const stories = await CommunitySubmission
      .find({
        $or: [
          { reporterEmailNorm: normalizedEmail },
          { reporterEmail: normalizedEmail },
          { email: normalizedEmail },
          { 'contact.email': normalizedEmail },
        ],
        isDeleted: { $ne: true },
      })
      .sort({ createdAt: -1 })
      .lean();

    const payload = stories.map(s => ({
      id: String(s._id),
      headline: s.headline,
      summary: (s.summary || (s.body || '')).slice(0, 160),
      status: s.status,
      category: s.category,
      city: s.city || (s.location && s.location.city) || null,
      language: s.language || 'en',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    console.log('[MyStories] email =', normalizedEmail, 'count =', payload.length);
    return res.json({ ok: true, stories: payload });
  } catch (err) {
    console.error('MyStories: failed to load stories', err);
    return res.status(500).json({ ok: false, message: 'Failed to load stories' });
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

// Phase 1 endpoint (public): simplified submit payload
// POST /api/community-reporter/submit
// Accepts: { name, email, location, headline, story, ageGroup }
router.post('/submit', async (req, res) => {
  try {
    const body = req.body || {};
    const {
      name,
      email,
      location,
      headline,
      story,
      ageGroup,
    } = body;

    const reporterName = String(name || '').trim();
    const reporterEmail = String(email || '').trim().toLowerCase();
    const reporterLocation = String(location || '').trim();
    const headlineNorm = String(headline || '').trim();
    const storyNorm = String(story || '').trim();
    const ageGroupNorm = (ageGroup === undefined || ageGroup === null) ? undefined : String(ageGroup).trim();

    const errors = [];
    if (!reporterName) errors.push('name required');
    if (!reporterEmail) errors.push('email required');
    if (!headlineNorm) errors.push('headline required');
    if (!storyNorm) errors.push('story required');
    if (errors.length) {
      return res.status(400).json({ ok: false, message: 'Validation failed', errors });
    }

    const submission = await CommunitySubmission.create({
      reporterName,
      reporterEmail,
      reporterLocation: reporterLocation || undefined,
      name: reporterName,
      email: reporterEmail,
      headline: headlineNorm,
      body: storyNorm,
      ageGroup: ageGroupNorm,
      status: 'under_review',
    });

    return res.status(201).json({ ok: true, id: submission._id.toString() });
  } catch (e) {
    console.error('[COMMUNITY_REPORTER][submit-error]', e);
    return res.status(500).json({ ok: false, message: 'Server error creating submission' });
  }
});
// Keep legacy handler exported but our above inline endpoint returns desired shape
// router.get('/my-stories', listMyCommunityReports);

// Note: queue endpoint temporarily served publicly via app-level route in server.js

module.exports = router;