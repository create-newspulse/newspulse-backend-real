const mongoose = require('mongoose');
const YouthPulseContributor = require('../models/YouthPulseContributor');
const YouthPulseSubmission = require('../models/YouthPulseSubmission');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function cleanText(value, maxLength = 0) {
  const text = String(value || '').trim();
  if (!text) return null;
  return maxLength > 0 ? text.slice(0, maxLength) : text;
}

function buildYouthPulseContributorFilter(query = {}) {
  const and = [];
  const status = cleanText(query.status, 24);
  const city = cleanText(query.city, 80);
  const state = cleanText(query.state, 80);
  const search = cleanText(query.q || query.search, 120);

  if (status) and.push({ status });
  if (city) and.push({ city });
  if (state) and.push({ state });
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(escaped, 'i');
    and.push({
      $or: [
        { fullName: rx },
        { email: rx },
        { mobile: rx },
        { college: rx },
        { city: rx },
        { state: rx },
      ],
    });
  }

  return and.length ? { $and: and } : {};
}

function toYouthPulseContributorDto(doc = {}) {
  return {
    id: doc._id ? String(doc._id) : null,
    fullName: doc.fullName || null,
    email: doc.email || null,
    mobile: doc.mobile || null,
    college: doc.college || null,
    city: doc.city || null,
    state: doc.state || null,
    totalSubmissions: Number(doc.totalSubmissions || 0),
    totalApproved: Number(doc.totalApproved || 0),
    totalPublished: Number(doc.totalPublished || 0),
    lastSubmissionAt: doc.lastSubmissionAt || null,
    notes: doc.notes || null,
    status: doc.status || 'active',
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

async function syncYouthPulseContributorStats(contributorId) {
  if (!contributorId || !mongoose.isValidObjectId(String(contributorId))) return null;

  const [stats] = await YouthPulseSubmission.aggregate([
    { $match: { contributorId: new mongoose.Types.ObjectId(String(contributorId)) } },
    {
      $group: {
        _id: '$contributorId',
        totalSubmissions: { $sum: 1 },
        totalApproved: {
          $sum: {
            $cond: [{ $in: ['$status', ['approved', 'draft_created', 'published']] }, 1, 0],
          },
        },
        totalPublished: {
          $sum: {
            $cond: [{ $eq: ['$status', 'published'] }, 1, 0],
          },
        },
        lastSubmissionAt: { $max: '$createdAt' },
      },
    },
  ]);

  return YouthPulseContributor.findByIdAndUpdate(
    contributorId,
    {
      $set: {
        totalSubmissions: Number(stats?.totalSubmissions || 0),
        totalApproved: Number(stats?.totalApproved || 0),
        totalPublished: Number(stats?.totalPublished || 0),
        lastSubmissionAt: stats?.lastSubmissionAt || null,
      },
    },
    { new: true }
  );
}

async function upsertYouthPulseContributor(payload = {}) {
  const email = normalizeEmail(payload.email);
  if (!email) {
    throw new Error('Youth Pulse contributor email is required');
  }

  const update = {
    fullName: cleanText(payload.fullName, 120) || email,
    mobile: cleanText(payload.mobile, 32),
    college: cleanText(payload.college, 160),
    city: cleanText(payload.city, 80),
    state: cleanText(payload.state, 80),
  };

  const existing = await YouthPulseContributor.findOne({ email });
  if (!existing) {
    return YouthPulseContributor.create({
      ...update,
      email,
      status: cleanText(payload.status, 24) || 'active',
      notes: cleanText(payload.notes, 4000),
      lastSubmissionAt: payload.lastSubmissionAt || null,
    });
  }

  if (update.fullName) existing.fullName = update.fullName;
  if (update.mobile) existing.mobile = update.mobile;
  if (update.college !== null) existing.college = update.college;
  if (update.city !== null) existing.city = update.city;
  if (update.state !== null) existing.state = update.state;
  if (payload.notes !== undefined) existing.notes = cleanText(payload.notes, 4000);
  if (payload.status !== undefined) existing.status = cleanText(payload.status, 24) || existing.status;
  if (payload.lastSubmissionAt) existing.lastSubmissionAt = payload.lastSubmissionAt;
  await existing.save();
  return existing;
}

module.exports = {
  buildYouthPulseContributorFilter,
  syncYouthPulseContributorStats,
  toYouthPulseContributorDto,
  upsertYouthPulseContributor,
};