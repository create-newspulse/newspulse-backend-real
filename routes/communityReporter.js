const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');

const router = express.Router();

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
    const { name, email, location, category, headline, story } = req.body || {};
    const errors = [];
    if (!name || !name.trim()) errors.push('name required');
    if (!email || !email.trim()) errors.push('email required');
    if (!location || !location.trim()) errors.push('location required');
    if (!category || !category.trim()) errors.push('category required');
    if (!headline || !headline.trim()) errors.push('headline required');
    if (!story || !story.trim()) errors.push('story required');
    if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });

    const submission = await CommunitySubmission.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      location: location.trim(),
      category: category.trim(),
      headline: headline.trim(),
      body: story.trim(), // underlying field
      status: 'NEW',
    });
    return res.status(201).json({ success: true, item: {
      id: submission._id.toString(),
      name: submission.name,
      email: submission.email,
      location: submission.location,
      category: submission.category,
      headline: submission.headline,
      story: submission.body,
      status: externalStatus(submission.status),
      createdAt: submission.createdAt,
    }});
  } catch (e) {
    console.error('[COMMUNITY_REPORTER][create-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Server error creating submission' });
  }
});

module.exports = router;