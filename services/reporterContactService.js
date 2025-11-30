const ReporterContact = require('../models/ReporterContact');

// Helper: safely apply provided value only if not undefined/null
function applyIfPresent(target, key, value) {
  if (value === undefined || value === null) return;
  // Empty string should not overwrite existing non-empty data unless explicitly provided
  if (typeof value === 'string' && value.trim() === '') return;
  target[key] = value;
}

/**
 * Upsert ReporterContact from incoming submission / journalist application payload.
 * Lookup is strictly by email (unique identifier in schema).
 * Does NOT erase existing good data with undefined / empty values.
 * @param {Object} payload
 * @returns {Promise<import('mongoose').Document>}
 */
async function upsertReporterContactFromSubmission(payload) {
  const {
    name,
    email,
    phone,
    city,
    state,
    country,
    reporterType,
    organisationName,
    organisationType,
    positionTitle,
    beatsProfessional,
    yearsExperience,
    languages,
    websiteOrPortfolio,
    socialLinks,
  } = payload || {};

  if (!email || !String(email).trim()) {
    throw new Error('Reporter email is required');
  }
  const emailNorm = String(email).trim().toLowerCase();

  // Fetch existing contact (lean false for save operations later)
  let contact = await ReporterContact.findOne({ email: emailNorm });

  if (!contact) {
    // Create new with defaults
    contact = new ReporterContact({
      fullName: name || 'Unknown',
      email: emailNorm,
      reporterType: reporterType || 'community',
      // verificationLevel stays default 'unverified' – journalist flow may elevate to pending later
    });
    applyIfPresent(contact, 'phoneFull', phone);
    applyIfPresent(contact, 'cityTownVillage', city);
    applyIfPresent(contact, 'stateName', state);
    applyIfPresent(contact, 'country', country);
  } else {
    // Update only provided non-empty values
    applyIfPresent(contact, 'fullName', name);
    applyIfPresent(contact, 'phoneFull', phone);
    applyIfPresent(contact, 'cityTownVillage', city);
    applyIfPresent(contact, 'stateName', state);
    applyIfPresent(contact, 'country', country);
    if (reporterType && (contact.reporterType !== reporterType)) {
      contact.reporterType = reporterType;
    }
  }

  // Journalist-specific extras (only apply if present)
  applyIfPresent(contact, 'organisationName', organisationName);
  applyIfPresent(contact, 'organisationType', organisationType);
  applyIfPresent(contact, 'positionTitle', positionTitle);
  if (Array.isArray(beatsProfessional) && beatsProfessional.length) {
    contact.beatsProfessional = beatsProfessional;
  }
  if (typeof yearsExperience === 'number') {
    contact.yearsExperience = yearsExperience;
  }
  if (Array.isArray(languages) && languages.length) {
    contact.languages = languages;
  }
  applyIfPresent(contact, 'websiteOrPortfolio', websiteOrPortfolio);
  if (socialLinks && typeof socialLinks === 'object') {
    // Only copy provided subkeys
    contact.socialLinks = contact.socialLinks || {};
    applyIfPresent(contact.socialLinks, 'linkedin', socialLinks.linkedin);
    applyIfPresent(contact.socialLinks, 'twitter', socialLinks.twitter);
  }

  await contact.save();
  return contact;
}

module.exports = { upsertReporterContactFromSubmission };