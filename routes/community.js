const express = require('express');
const mongoose = require('mongoose');
const CommunitySubmission = require('../models/CommunitySubmission');
const YouthPulseSubmission = require('../models/YouthPulseSubmission');
const { runCommunityAiReview } = require('../services/communityAiReview');
const {
  buildYouthPulseSubmissionCreate,
  toYouthPulseAdminDto,
  validateYouthPulsePublicPayload,
} = require('../services/youthPulseSubmission.service');
const { syncYouthPulseContributorStats, upsertYouthPulseContributor } = require('../services/youthPulseContributor.service');
const {
  COMMUNITY_REPORTER_CATEGORIES,
  extractSubmissionAttachments,
  inferSubmissionDeskMetadata,
  normalizeCommunityReporterCategory,
  normalizeWorkflowStatus,
} = require('../services/communitySubmissionWorkflow');
const {
  buildAgeGroupValidationError,
  normalizeAgeGroup,
} = require('../services/communitySubmissionAgeGroup');
const { getEffectiveCommunityAccessState } = require('../services/communityAccessToggleService');
const router = express.Router();

function shouldLogYouthPulsePublic() {
  return String(process.env.NODE_ENV || '').toLowerCase() !== 'production';
}

function summarizeYouthPulsePayload(body = {}) {
  const rawStory = body.storyBody || body.story || body.body || body.content || '';
  return {
    keys: Object.keys(body || {}).sort(),
    track: body.track || body.selectedPublicTrack || null,
    submissionType: body.submissionType || body.storyType || body.contentType || null,
    hasStory: Boolean(String(rawStory || '').trim()),
    storyLength: String(rawStory || '').trim().length,
    hasKnowledgeSource: body.firstHandClaim !== undefined
      || body.firstHand !== undefined
      || body.isFirstHand !== undefined
      || body.knowledgeSource !== undefined,
    hasConsentGroup: Boolean(body.consents || body.consent || body.requiredConsents),
  };
}

function logYouthPulsePublic(event, payload) {
  if (!shouldLogYouthPulsePublic()) return;
  try {
    console.log(`[YOUTH_PULSE][public] ${event}`, payload);
  } catch (_) {}
}

function normalizeCategoryAliasToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const COMMUNITY_REPORTER_CATEGORY_ALIAS_MAP = (() => {
  const entries = COMMUNITY_REPORTER_CATEGORIES.map((category) => [normalizeCategoryAliasToken(category), category]);
  return new Map(entries.concat([
    ['local', 'Regional'],
    ['regional-news', 'Regional'],
    ['civic', 'Civic Issue'],
    ['crime', 'Crime / Police'],
    ['police', 'Crime / Police'],
    ['government', 'Government / Public Services'],
    ['public-services', 'Government / Public Services'],
    ['politics', 'Politics / Local Leadership'],
    ['education', 'Education / School / College'],
    ['health', 'Health / Hospital'],
    ['weather', 'Weather / Disaster'],
    ['disaster', 'Weather / Disaster'],
    ['business', 'Business / Market'],
    ['sports', 'Sports'],
    ['youth', 'Youth / Campus'],
    ['campus', 'Youth / Campus'],
    ['lifestyle', 'Lifestyle / Culture'],
    ['culture', 'Lifestyle / Culture'],
    ['entertainment', 'Entertainment / Events'],
    ['events', 'Entertainment / Events'],
    ['environment', 'Environment'],
    ['achievement', 'Achievement / Inspiration'],
    ['inspiration', 'Achievement / Inspiration'],
    ['general', 'General Tip'],
    ['tip', 'General Tip'],
    ['other', 'General Tip'],
  ]));
})();

function normalizePublicCommunityCategory(value) {
  const canonical = normalizeCommunityReporterCategory(value);
  if (canonical) return canonical;
  return COMMUNITY_REPORTER_CATEGORY_ALIAS_MAP.get(normalizeCategoryAliasToken(value)) || null;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function firstNonEmptyValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (typeof value !== 'string' && !String(value).trim()) continue;
    return value;
  }
  return undefined;
}

function firstProvidedValue(body, keys) {
  const groups = [body, body?.consents, body?.consent, body?.requiredConsents, body?.confirm];
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(group, key)) return group[key];
    }
  }
  return undefined;
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  if (typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number' && (value === 0 || value === 1)) return { ok: true, value: value === 1 };
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(token)) return { ok: true, value: true };
    if (['false', '0', 'no', 'off'].includes(token)) return { ok: true, value: false };
  }
  return { ok: false };
}

function getPublicSubmissionConsentValues(body, fieldErrors) {
  const definitions = [
    ['acceptTerms', ['acceptTerms', 'acceptedTerms', 'termsAccepted', 'consent', 'confirm', 'confirmed']],
    ['acceptedPolicy', ['acceptedPolicy', 'policyAccepted', 'privacyAccepted']],
    ['confirmTruthful', ['confirmTruthful', 'consentTruthful', 'truthful']],
    ['confirmRightsToShare', ['confirmRightsToShare', 'consentRightsToShare', 'rightsToShare', 'rights']],
    ['confirmEditorialReviewAllowed', ['confirmEditorialReviewAllowed', 'consentEditorialReviewAllowed', 'editorialReviewAllowed', 'editorialReview']],
    ['confirmNoUnsafeFalseAbusiveContent', ['confirmNoUnsafeFalseAbusiveContent', 'consentNoUnsafeFalseAbusiveContent', 'noUnsafeFalseAbusiveContent', 'safeContent']],
  ];
  const values = {};
  for (const [field, keys] of definitions) {
    const parsed = parseOptionalBoolean(firstProvidedValue(body, keys));
    if (!parsed.ok) {
      fieldErrors.push({ field, code: 'invalid_boolean', message: `${field} must be a boolean when provided` });
    } else if (parsed.value !== undefined) {
      values[field] = parsed.value;
    }
  }
  return values;
}

function buildPublicSubmissionValidationResponse(fieldErrors) {
  const normalizedErrors = fieldErrors.map((entry) => {
    if (typeof entry === 'string') return { field: entry, code: 'invalid', message: `${entry} is invalid` };
    return entry;
  });
  const fields = Array.from(new Set(normalizedErrors.map((entry) => entry.field).filter(Boolean)));
  return {
    success: false,
    ok: false,
    code: 'VALIDATION_ERROR',
    error: 'VALIDATION_ERROR',
    fields,
    message: 'Required submission fields are missing or invalid.',
    fieldErrors: normalizedErrors,
  };
}

async function createYouthPulseSubmission(req, res) {
  try {
    const accessState = await getEffectiveCommunityAccessState();
    if (accessState.youthPulseSubmissionsClosed) {
      return res.status(403).json({
        ok: false,
        success: false,
        message: 'Youth Pulse submissions are temporarily closed.',
      });
    }

    logYouthPulsePublic('request_received', summarizeYouthPulsePayload(req.body || {}));

    const parsed = validateYouthPulsePublicPayload(req.body || {});
    if (parsed.errors.length) {
      logYouthPulsePublic('validation_failed', {
        summary: summarizeYouthPulsePayload(req.body || {}),
        errors: parsed.errors,
        fieldErrors: parsed.fieldErrors,
      });
      return res.status(400).json({
        success: false,
        ok: false,
        message: 'Validation failed',
        errors: parsed.errors,
        fieldErrors: parsed.fieldErrors,
      });
    }

    const contributor = await upsertYouthPulseContributor({
      fullName: parsed.value.fullName,
      email: parsed.value.email,
      mobile: parsed.value.mobile,
      college: parsed.value.college,
      city: parsed.value.city,
      state: parsed.value.state,
      lastSubmissionAt: new Date(),
    });

    const submission = await YouthPulseSubmission.create(
      buildYouthPulseSubmissionCreate(parsed.value, req, contributor._id)
    );
    await syncYouthPulseContributorStats(contributor._id).catch(() => null);

    logYouthPulsePublic('submission_created', {
      submissionId: String(submission._id),
      status: submission.status,
      track: submission.track || null,
      sourceType: submission.sourceType || null,
    });

    return res.status(201).json({
      success: true,
      ok: true,
      message: 'Youth Pulse submission received for editorial review',
      submissionId: String(submission._id),
      item: toYouthPulseAdminDto(submission.toObject ? submission.toObject() : submission),
    });
  } catch (err) {
    console.error('[YOUTH_PULSE][create] error', err);
    logYouthPulsePublic('submission_failed', {
      name: err?.name || null,
      message: err?.message || null,
      validationKeys: err?.errors ? Object.keys(err.errors) : [],
    });
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ success: false, ok: false, message: 'Validation error', details: err.errors });
    }
    return res.status(500).json({ success: false, ok: false, message: 'Failed to submit Youth Pulse story' });
  }
}

router.post('/youth-pulse/submissions', createYouthPulseSubmission);
router.post('/submissions/youth-pulse', createYouthPulseSubmission);

// Phase-1 public submission endpoint (POST /api/community/submissions)
router.post('/submissions', async (req, res) => {
  try {
    const b = req.body || {};
    const deskMeta = inferSubmissionDeskMetadata(b);
    const userName = firstNonEmptyString(b.userName, b.reporterName, b.name, b.fullName, b.reporter?.name);
    const email = firstNonEmptyString(b.email, b.reporterEmail, b.reporter?.email, b.contact?.email).toLowerCase();
    const headline = firstNonEmptyString(b.headline, b.title);
    const body = firstNonEmptyString(b.body, b.story, b.storyText, b.content, b.storyBody);
    const category = firstNonEmptyString(b.category, b.track);

    const locationText = typeof b.location === 'string' ? b.location : '';
    const city = firstNonEmptyString(b.city, b.location?.city, locationText, b.reporterLocation);
    const state = firstNonEmptyString(b.state, b.location?.state);
    const country = firstNonEmptyString(b.country, b.location?.country);
    const district = firstNonEmptyString(b.district, b.location?.district);
    const ageGroup = firstNonEmptyValue(b.ageGroup, b.reporterAgeGroup);
    const normalizedAgeGroup = ageGroup !== undefined ? normalizeAgeGroup(ageGroup) : undefined;
    const mediaLink = firstNonEmptyString(b.mediaLink, b.mediaUrl);
    const attachments = extractSubmissionAttachments(b);
    const contact = {
      name: firstNonEmptyString(b.contact?.name, b.contactName, userName) || undefined,
      email: firstNonEmptyString(b.contact?.email, b.contactEmail, email) || undefined,
      phone: firstNonEmptyString(b.contact?.phone, b.contactPhone, b.phone) || undefined,
      preferredContact: firstNonEmptyString(b.contact?.preferredContact, b.preferredContact, 'no_preference') || 'no_preference',
      canContactForThisStory: Boolean(b.contact?.canContactForThisStory ?? b.canContactForThisStory ?? false),
      canContactForFutureStories: Boolean(b.contact?.canContactForFutureStories ?? b.canContactForFutureStories ?? false),
    };

    // Basic validation
    const fieldErrors = [];
    if (!userName) fieldErrors.push({ field: 'userName', code: 'required', message: 'userName is required' });
    if (!email) fieldErrors.push({ field: 'email', code: 'required', message: 'email is required' });
    if (!headline) fieldErrors.push({ field: 'headline', code: 'required', message: 'headline is required' });
    if (!body) fieldErrors.push({ field: 'body', code: 'required', message: 'body is required' });
    if (!category) fieldErrors.push({ field: 'category', code: 'required', message: 'category is required' });

    if (headline && headline.length > 200) fieldErrors.push({ field: 'headline', code: 'too_long', message: 'headline must be <= 200 chars' });
    if (body && body.length > 10000) fieldErrors.push({ field: 'body', code: 'too_long', message: 'body must be <= 10000 chars' });

    const normalizedCategory = normalizePublicCommunityCategory(category);
    if (category && !normalizedCategory) {
      fieldErrors.push({
        field: 'category',
        code: 'invalid_enum',
        message: `category must be one of: ${COMMUNITY_REPORTER_CATEGORIES.join(', ')}`,
        allowedValues: COMMUNITY_REPORTER_CATEGORIES,
      });
    }
    if (ageGroup !== undefined && !normalizedAgeGroup) fieldErrors.push(buildAgeGroupValidationError());

    const consentValues = getPublicSubmissionConsentValues(b, fieldErrors);

    if (fieldErrors.length) {
      return res.status(400).json(buildPublicSubmissionValidationResponse(fieldErrors));
    }

    const ipAddress = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || req.connection?.remoteAddress || '';
    const userAgent = req.get('user-agent') || '';

    // Build submissionData with safe defaults
    const submissionData = {
      userName,
      reporterName: userName,
      name: userName,
      email,
      reporterEmail: email,
      headline,
      body,
      category: normalizedCategory,
      ageGroup: normalizedAgeGroup || undefined,
      reporterAgeGroup: normalizedAgeGroup || undefined,
      city: city || undefined,
      state: state || undefined,
      country: country || undefined,
      location: { city: city || null, state: state || null, country: country || null },
      reporterLocation: city || undefined,
      locationDetail: { city: city || undefined, state: state || undefined, country: country || undefined, district: district || undefined },
      contact,
      desk: deskMeta.desk || undefined,
      submissionType: deskMeta.submissionType || undefined,
      intakeSource: deskMeta.intakeSource || undefined,
      track: deskMeta.track || undefined,
      attachments,
      mediaLink: mediaLink || undefined,
      mediaUrl: mediaLink || (attachments[0] && attachments[0].url) || undefined,
      // Defaults requested
      status: deskMeta.isYouthPulse
        ? normalizeWorkflowStatus(b.status, 'NEW')
        : 'PENDING_FOUNDER',
      sourceType: 'community',
      reporterVerificationLevel: 'unverified',
      ...consentValues,
      ipAddress,
      userAgent,
    };

    const saved = await CommunitySubmission.create(submissionData);

    // Contributor network linkage (best-effort; never blocks submission)
    try {
      const { resolveAndAttachForSubmission } = require('../services/reporterIdentityResolution.service');
      await resolveAndAttachForSubmission(saved, { req });
    } catch (_) {}

    // Fire-and-forget reporter contact upsert (non-blocking)
    try {
      const { upsertReporterContactFromPayload } = require('../services/reporterContactService');
      await upsertReporterContactFromPayload({
        name: saved.reporterName || saved.name,
        email: saved.reporterEmail || saved.email,
        city: saved.city || saved.location?.city,
        state: saved.state,
        country: saved.country,
        reporterType: 'community',
      });
    } catch (err) {
      console.error('[COMMUNITY_SUBMISSION][contact-upsert] failed', err?.message || err);
    }

    // Optional AI review step (non-blocking)
    try {
      const ai = await runCommunityAiReview({
        userName,
        city,
        category: normalizedCategory,
        headline,
        body,
        ageGroup: normalizedAgeGroup,
      });
      saved.aiTitle = ai.aiTitle;
      saved.aiBody = ai.aiBody;
      saved.riskScore = ai.riskScore;
      saved.flags = ai.flags;
      saved.policyNotes = ai.policyNotes;
      saved.aiSuggestedCategory = ai.aiSuggestedCategory;
      saved.aiSuggestedTags = ai.aiSuggestedTags;
      saved.aiTipOnlySuggested = ai.aiTipOnlySuggested;
      await saved.save();
    } catch (aiErr) {
      console.error('[COMMUNITY_SUBMISSION][ai-review] failed', aiErr?.message || aiErr);
      // Do not fail request
    }

    return res.status(201).json({
      success: true,
      ok: true,
      item: {
        id: saved._id.toString(),
        userName: saved.userName || saved.reporterName || saved.name,
        email: saved.email || saved.reporterEmail,
        city: saved.city || (saved.location && saved.location.city) || null,
        state: saved.state || null,
        country: saved.country || null,
        ageGroup: saved.ageGroup || saved.reporterAgeGroup || null,
        headline: saved.headline,
        body: saved.body,
        category: saved.category,
        desk: saved.desk || null,
        track: saved.track || null,
        submissionType: saved.submissionType || null,
        intakeSource: saved.intakeSource || null,
        attachments: Array.isArray(saved.attachments) ? saved.attachments : [],
        mediaLink: saved.mediaLink || null,
        status: saved.status,
        aiTitle: saved.aiTitle || null,
        aiBody: saved.aiBody || null,
        riskScore: saved.riskScore || 0,
        flags: Array.isArray(saved.flags) ? saved.flags : [],
        policyNotes: saved.policyNotes || null,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      }
    });
  } catch (err) {
    console.error('[COMMUNITY_SUBMISSION][create] error', err);
    if (err && err.name === 'ValidationError') {
      const fieldErrors = Object.keys(err.errors || {}).map((field) => ({
        field,
        code: 'invalid_model_field',
        message: `${field} is invalid`,
      }));
      return res.status(400).json(buildPublicSubmissionValidationResponse(fieldErrors));
    }
    return res.status(500).json({ success: false, ok: false, message: 'Failed to submit community story' });
  }
});

module.exports = router;
