const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const router = express.Router();

// POST /api/community/submissions
router.post('/submissions', async (req, res) => {
  try {
    const { name, email, location, category, headline, body } = req.body || {};
    const errors = [];
    if (!name || !name.trim()) errors.push('Name is required');
    if (!email || !email.trim()) errors.push('Email is required');
    if (!category || !category.trim()) errors.push('Category is required');
    if (!headline || !headline.trim()) errors.push('Headline is required');
    if (!body || !body.trim()) errors.push('Body is required');
    if (body && body.trim().length < 50) errors.push('Body must be at least 50 characters');
    if (errors.length) return res.status(400).json({ success: false, ok: false, message: 'Validation failed', errors });

    const normalizedEmail = email.trim().toLowerCase();
    const submission = await CommunitySubmission.create({
      name: name.trim(),
      email: normalizedEmail,
      location: location ? location.trim() : undefined,
      category: category.trim(),
      headline: headline.trim(),
      body: body.trim(),
      status: 'NEW',
    });
    return res.status(201).json({ success: true, ok: true, submissionId: submission._id.toString(), message: 'Thank you, your story is under review.' });
  } catch (e) {
    console.error('[COMMUNITY][create-error]', e?.message || e);
    return res.status(500).json({ success: false, ok: false, message: 'Server error creating submission' });
  }
});

module.exports = router;
