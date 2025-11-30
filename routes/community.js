const express = require('express');
const mongoose = require('mongoose');
const CommunitySubmission = require('../models/CommunitySubmission');
const { runCommunityAiReview } = require('../services/communityAiReview');
const router = express.Router();

// Phase-1 public submission endpoint (POST /api/community/submissions)
router.post('/submissions', async (req, res) => {
  try {
    const b = req.body || {};
    const userName = (b.userName || b.reporterName || b.name || '').toString().trim();
    const email = (b.email || b.reporterEmail || '').toString().trim().toLowerCase();
    const headline = (b.headline || '').toString().trim();
    const body = (b.body || b.story || b.storyText || b.content || '').toString().trim();
    const category = (b.category || '').toString().trim();

    const city = (b.city || b.location?.city || b.location || b.reporterLocation || '').toString().trim();
    const state = (b.state || b.location?.state || '').toString().trim();
    const country = (b.country || b.location?.country || '').toString().trim();
    const district = (b.district || b.location?.district || '').toString().trim();
    const ageGroup = (b.ageGroup || b.reporterAgeGroup || '').toString().trim();
    const mediaLink = (b.mediaLink || b.mediaUrl || '').toString().trim();
    const contact = {
      name: (b.contact?.name || b.contactName || userName).toString().trim() || undefined,
      email: (b.contact?.email || b.contactEmail || email).toString().trim() || undefined,
      phone: (b.contact?.phone || b.contactPhone || '').toString().trim() || undefined,
      preferredContact: (b.contact?.preferredContact || b.preferredContact || 'no_preference').toString().trim() || 'no_preference',
      canContactForThisStory: Boolean(b.contact?.canContactForThisStory ?? b.canContactForThisStory ?? false),
      canContactForFutureStories: Boolean(b.contact?.canContactForFutureStories ?? b.canContactForFutureStories ?? false),
    };

    // Basic validation
    const errors = [];
    if (!userName) errors.push('userName is required');
    if (!email) errors.push('email is required');
    if (!headline) errors.push('headline is required');
    if (!body) errors.push('body is required');
    if (!category) errors.push('category is required');

    if (headline && headline.length > 200) errors.push('headline must be <= 200 chars');
    if (body && body.length > 10000) errors.push('body must be <= 10000 chars');

    if (errors.length) {
      return res.status(400).json({ success: false, ok: false, message: 'Validation failed', errors });
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
      category,
      ageGroup: ageGroup || undefined,
      reporterAgeGroup: ageGroup || undefined,
      city: city || undefined,
      state: state || undefined,
      country: country || undefined,
      location: { city: city || null, state: state || null, country: country || null },
      reporterLocation: city || undefined,
      locationDetail: { city: city || undefined, state: state || undefined, country: country || undefined, district: district || undefined },
      contact,
      mediaLink: mediaLink || undefined,
      mediaUrl: mediaLink || undefined,
      // Defaults requested
      status: b.status || 'PENDING_FOUNDER',
      sourceType: b.sourceType || 'community',
      reporterVerificationLevel: b.reporterVerificationLevel || 'unverified',
      ipAddress,
      userAgent,
    };

    const saved = await CommunitySubmission.create(submissionData);

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
        category,
        headline,
        body,
        ageGroup,
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
      return res.status(400).json({ success: false, ok: false, message: 'Validation error', details: err.errors });
    }
    return res.status(500).json({ success: false, ok: false, message: 'Failed to submit community story' });
  }
});

module.exports = router;
