const mongoose = require('mongoose');
const ComplianceReport = require('../models/ComplianceReport');

const MONTH_ORDER = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const SEEDED_REPORT = {
  month: 'April',
  year: 2026,
  label: 'April 2026',
  publishedDate: '12 May 2026',
  complaintsReceived: 0,
  complaintsResolved: 0,
  averageResponseTime: 'Nil',
  complaintsPending: 0,
  actionTakenOnOrders: 'Nil',
  note: 'No grievances were received during this reporting month.',
  status: 'Published',
};

function isDbReady() {
  return !!(mongoose.connection && mongoose.connection.readyState === 1);
}

function normalizeRequiredString(value) {
  return String(value || '').trim();
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeMonth(month) {
  const trimmed = normalizeRequiredString(month);
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function normalizeStatus(status) {
  const trimmed = normalizeRequiredString(status);
  if (!trimmed) return 'Draft';
  if (trimmed.toLowerCase() === 'published') return 'Published';
  if (trimmed.toLowerCase() === 'draft') return 'Draft';
  return trimmed;
}

function parseNonNegativeNumber(value, fieldName, errors) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    errors.push(`${fieldName} must be a valid number`);
    return 0;
  }
  if (parsed < 0) {
    errors.push(`${fieldName} cannot be negative`);
    return 0;
  }
  return parsed;
}

function getNumericFieldValue(body, primaryField, legacyField) {
  if (body[primaryField] !== undefined) return body[primaryField];
  if (body[legacyField] !== undefined) return body[legacyField];
  return 0;
}

function normalizeReportOutput(report) {
  if (!report || typeof report !== 'object') return report;

  const complaintsReceived = Number(report.complaintsReceived ?? report.grievancesReceived ?? 0);
  const complaintsResolved = Number(report.complaintsResolved ?? report.grievancesResolved ?? 0);
  const complaintsPending = Number(report.complaintsPending ?? report.grievancesPending ?? 0);

  return {
    ...report,
    complaintsReceived,
    complaintsResolved,
    complaintsPending,
    grievancesReceived: complaintsReceived,
    grievancesResolved: complaintsResolved,
    grievancesPending: complaintsPending,
  };
}

function buildCompliancePayload(body = {}) {
  const errors = [];
  const month = normalizeMonth(body.month);
  const yearRaw = body.year;
  const label = normalizeRequiredString(body.label);
  const status = normalizeStatus(body.status);

  if (!month) errors.push('month is required');
  if (yearRaw === undefined || yearRaw === null || String(yearRaw).trim() === '') {
    errors.push('year is required');
  }

  const year = Number(yearRaw);
  if (yearRaw !== undefined && yearRaw !== null && String(yearRaw).trim() !== '') {
    if (!Number.isInteger(year) || year < 0) {
      errors.push('year must be a valid non-negative integer');
    }
  }

  if (!label) errors.push('label is required');
  if (status !== 'Draft' && status !== 'Published') {
    errors.push('status must be Draft or Published');
  }

  const payload = {
    month,
    year: Number.isInteger(year) ? year : yearRaw,
    label,
    publishedDate: normalizeOptionalString(body.publishedDate),
    complaintsReceived: parseNonNegativeNumber(
      getNumericFieldValue(body, 'grievancesReceived', 'complaintsReceived'),
      'grievancesReceived',
      errors,
    ),
    complaintsResolved: parseNonNegativeNumber(
      getNumericFieldValue(body, 'grievancesResolved', 'complaintsResolved'),
      'grievancesResolved',
      errors,
    ),
    averageResponseTime: normalizeOptionalString(body.averageResponseTime),
    complaintsPending: parseNonNegativeNumber(
      getNumericFieldValue(body, 'grievancesPending', 'complaintsPending'),
      'grievancesPending',
      errors,
    ),
    actionTakenOnOrders: normalizeOptionalString(body.actionTakenOnOrders),
    note: normalizeOptionalString(body.note),
    status,
  };

  return { payload, errors };
}

function sortNewestFirst(items) {
  return [...items].sort((left, right) => {
    const yearDiff = Number(right.year || 0) - Number(left.year || 0);
    if (yearDiff !== 0) return yearDiff;

    const rightMonth = MONTH_ORDER[String(right.month || '').trim().toLowerCase()] || 0;
    const leftMonth = MONTH_ORDER[String(left.month || '').trim().toLowerCase()] || 0;
    if (rightMonth !== leftMonth) return rightMonth - leftMonth;

    return new Date(right.updatedAt || right.createdAt || 0).getTime() - new Date(left.updatedAt || left.createdAt || 0).getTime();
  });
}

async function ensureSeededReport() {
  if (!isDbReady()) return null;

  const total = await ComplianceReport.countDocuments({});
  if (total > 0) return null;

  return ComplianceReport.findOneAndUpdate(
    { month: SEEDED_REPORT.month, year: SEEDED_REPORT.year },
    { $setOnInsert: SEEDED_REPORT },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      runValidators: true,
      collation: { locale: 'en', strength: 2 },
    },
  );
}

async function findDuplicateReport(month, year, excludeId) {
  const query = { month, year };
  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  return ComplianceReport.findOne(query).collation({ locale: 'en', strength: 2 }).lean();
}

function getActor(req) {
  return normalizeOptionalString(req.admin && (req.admin.email || req.admin.id || req.admin.name));
}

function sendDbUnavailable(res) {
  return res.status(503).json({ ok: false, message: 'Database unavailable' });
}

function sendValidationError(res, errors) {
  return res.status(400).json({ ok: false, message: 'Validation failed', errors });
}

function sendDuplicateError(res) {
  return res.status(409).json({ ok: false, message: 'A compliance report for that month and year already exists' });
}

async function listAdminComplianceReports(_req, res) {
  try {
    if (!isDbReady()) return sendDbUnavailable(res);

    await ensureSeededReport();
    const items = await ComplianceReport.find({}).lean();
    return res.status(200).json({ ok: true, items: sortNewestFirst(items).map(normalizeReportOutput) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || 'Failed to load compliance reports' });
  }
}

async function createComplianceReport(req, res) {
  try {
    if (!isDbReady()) return sendDbUnavailable(res);

    const { payload, errors } = buildCompliancePayload(req.body);
    if (errors.length > 0) return sendValidationError(res, errors);

    const duplicate = await findDuplicateReport(payload.month, payload.year);
    if (duplicate) return sendDuplicateError(res);

    const actor = getActor(req);
    const doc = await ComplianceReport.create({
      ...payload,
      ...(actor ? { createdBy: actor, updatedBy: actor } : {}),
    });

    return res.status(201).json({ ok: true, item: normalizeReportOutput(doc.toObject()) });
  } catch (error) {
    if (error && (error.code === 11000 || String(error.message || '').includes('E11000'))) {
      return sendDuplicateError(res);
    }
    if (error && error.name === 'ValidationError') {
      return sendValidationError(res, Object.values(error.errors || {}).map((entry) => entry.message));
    }
    return res.status(500).json({ ok: false, message: error?.message || 'Failed to create compliance report' });
  }
}

async function updateComplianceReport(req, res) {
  try {
    if (!isDbReady()) return sendDbUnavailable(res);

    const reportId = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(reportId)) {
      return res.status(400).json({ ok: false, message: 'Invalid compliance report id' });
    }

    const { payload, errors } = buildCompliancePayload(req.body);
    if (errors.length > 0) return sendValidationError(res, errors);

    const duplicate = await findDuplicateReport(payload.month, payload.year, reportId);
    if (duplicate) return sendDuplicateError(res);

    const actor = getActor(req);
    const doc = await ComplianceReport.findByIdAndUpdate(
      reportId,
      {
        $set: {
          ...payload,
          ...(actor ? { updatedBy: actor } : {}),
        },
      },
      { new: true, runValidators: true },
    ).lean();

    if (!doc) {
      return res.status(404).json({ ok: false, message: 'Compliance report not found' });
    }

    return res.status(200).json({ ok: true, item: normalizeReportOutput(doc) });
  } catch (error) {
    if (error && (error.code === 11000 || String(error.message || '').includes('E11000'))) {
      return sendDuplicateError(res);
    }
    if (error && error.name === 'ValidationError') {
      return sendValidationError(res, Object.values(error.errors || {}).map((entry) => entry.message));
    }
    return res.status(500).json({ ok: false, message: error?.message || 'Failed to update compliance report' });
  }
}

async function deleteComplianceReport(req, res) {
  try {
    if (!isDbReady()) return sendDbUnavailable(res);

    const reportId = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(reportId)) {
      return res.status(400).json({ ok: false, message: 'Invalid compliance report id' });
    }

    const doc = await ComplianceReport.findByIdAndDelete(reportId).lean();
    if (!doc) {
      return res.status(404).json({ ok: false, message: 'Compliance report not found' });
    }

    return res.status(200).json({ ok: true, item: normalizeReportOutput(doc) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || 'Failed to delete compliance report' });
  }
}

async function listPublicComplianceReports(_req, res) {
  try {
    if (!isDbReady()) return sendDbUnavailable(res);

    await ensureSeededReport();
    const items = await ComplianceReport.find({ status: 'Published' }).lean();
    return res.status(200).json({ ok: true, items: sortNewestFirst(items).map(normalizeReportOutput) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || 'Failed to load compliance reports' });
  }
}

module.exports = {
  createComplianceReport,
  deleteComplianceReport,
  listAdminComplianceReports,
  listPublicComplianceReports,
  updateComplianceReport,
};