const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const PrivacyRequest = require('../models/PrivacyRequest');
const DpdpAuditLog = require('../models/DpdpAuditLog');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PRIVACY_REQUESTS_FILE = path.join(DATA_DIR, 'privacy-requests.json');
const DPDP_AUDIT_LOGS_FILE = path.join(DATA_DIR, 'dpdp-audit-logs.json');

const REQUEST_TYPE_VALUES = PrivacyRequest.REQUEST_TYPE_VALUES;
const STATUS_VALUES = PrivacyRequest.STATUS_VALUES;
const PENDING_EMAIL_VERIFICATION_STATUS = 'Pending Email Verification';
const VERIFIED_STATUS = 'Verified';

function isDbReady() {
  return typeof mongoose?.connection?.readyState === 'number' && mongoose.connection.readyState === 1;
}

function ensureJsonFile(filePath) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]\n', 'utf8');
  } catch (_) {}
}

function readJsonArray(filePath) {
  ensureJsonFile(filePath);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeJsonArray(filePath, items) {
  ensureJsonFile(filePath);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(Array.isArray(items) ? items : [], null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeStoredRequest(doc) {
  if (!doc) return null;
  const source = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const out = cloneJson(source);
  if (out._id) out.id = String(out._id);
  delete out.__v;
  delete out.verificationTokenHash;
  return out;
}

function normalizeStoredAuditLog(doc) {
  if (!doc) return null;
  const source = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const out = cloneJson(source);
  if (out._id) out.id = String(out._id);
  delete out.__v;
  return out;
}

function sortNewestFirst(items) {
  return [...items].sort((left, right) => {
    const leftTime = new Date(left.createdAt || left.timestamp || 0).getTime();
    const rightTime = new Date(right.createdAt || right.timestamp || 0).getTime();
    return rightTime - leftTime;
  });
}

function buildAdminListFilter(status) {
  const statusValue = String(status || '').trim();
  if (statusValue && statusValue !== 'all') return { status: statusValue };
  if (statusValue === 'all') return {};
  return { status: { $ne: PENDING_EMAIL_VERIFICATION_STATUS } };
}

function applyFileFilter(items, status) {
  const statusValue = String(status || '').trim();
  if (statusValue && statusValue !== 'all') return items.filter((item) => item.status === statusValue);
  if (statusValue === 'all') return items;
  return items.filter((item) => item.status !== PENDING_EMAIL_VERIFICATION_STATUS);
}

function findFileRequestIndex(items, id) {
  const idValue = String(id || '').trim();
  return items.findIndex((item) => {
    if (!item || typeof item !== 'object') return false;
    return String(item.requestId || '') === idValue || String(item._id || '') === idValue || String(item.id || '') === idValue;
  });
}

function buildMongoIdFilter(id) {
  const idValue = String(id || '').trim();
  if (mongoose.isValidObjectId(idValue)) return { $or: [{ _id: idValue }, { requestId: idValue }] };
  return { requestId: idValue };
}

async function createPrivacyRequest(payload) {
  const nowIso = new Date().toISOString();
  const doc = {
    ...payload,
    source: payload.source || 'Frontend Form',
    status: payload.status || PENDING_EMAIL_VERIFICATION_STATUS,
    verifiedAt: payload.verifiedAt || null,
    adminNote: payload.adminNote || null,
    handledBy: payload.handledBy || null,
    replySentAt: payload.replySentAt || null,
    createdAt: payload.createdAt || nowIso,
    updatedAt: payload.updatedAt || nowIso,
  };

  if (isDbReady()) {
    try {
      return normalizeStoredRequest(await PrivacyRequest.create(doc));
    } catch (error) {
      console.warn('[dpdp][privacy-request][store] mongo create failed; falling back to file', error?.message || error);
    }
  }

  const items = readJsonArray(PRIVACY_REQUESTS_FILE);
  const fileDoc = { ...doc };
  items.push(fileDoc);
  writeJsonArray(PRIVACY_REQUESTS_FILE, items);
  return normalizeStoredRequest(fileDoc);
}

async function listPrivacyRequests({ status } = {}) {
  if (isDbReady()) {
    try {
      const docs = await PrivacyRequest.find(buildAdminListFilter(status)).sort({ createdAt: -1 }).limit(500).lean();
      return docs.map(normalizeStoredRequest);
    } catch (error) {
      console.warn('[dpdp][privacy-request][store] mongo list failed; falling back to file', error?.message || error);
    }
  }

  return sortNewestFirst(applyFileFilter(readJsonArray(PRIVACY_REQUESTS_FILE), status).map(normalizeStoredRequest));
}

async function getPrivacyRequestById(id) {
  if (isDbReady()) {
    try {
      return normalizeStoredRequest(await PrivacyRequest.findOne(buildMongoIdFilter(id)).lean());
    } catch (error) {
      console.warn('[dpdp][privacy-request][store] mongo get failed; falling back to file', error?.message || error);
    }
  }

  const items = readJsonArray(PRIVACY_REQUESTS_FILE);
  const index = findFileRequestIndex(items, id);
  return index >= 0 ? normalizeStoredRequest(items[index]) : null;
}

async function verifyPrivacyRequestByTokenHash(tokenHash, now = new Date()) {
  const nowDate = Number.isFinite(now?.getTime?.()) ? now : new Date();
  const nowIso = nowDate.toISOString();

  if (isDbReady()) {
    try {
      const doc = await PrivacyRequest.findOne({
        verificationTokenHash: tokenHash,
        verificationTokenExpiresAt: { $gt: nowDate },
      });
      if (!doc) return null;

      const oldStatus = doc.status || null;
      doc.status = VERIFIED_STATUS;
      doc.verifiedAt = doc.verifiedAt || nowDate;
      doc.verificationTokenHash = null;
      doc.verificationTokenExpiresAt = nowDate;
      await doc.save();
      return { request: normalizeStoredRequest(doc), oldStatus, newStatus: VERIFIED_STATUS };
    } catch (error) {
      console.warn('[dpdp][privacy-request][store] mongo verify failed; falling back to file', error?.message || error);
    }
  }

  const items = readJsonArray(PRIVACY_REQUESTS_FILE);
  const index = items.findIndex((item) => {
    if (!item || typeof item !== 'object') return false;
    if (item.verificationTokenHash !== tokenHash) return false;
    const expiresAt = new Date(item.verificationTokenExpiresAt || 0).getTime();
    return Number.isFinite(expiresAt) && expiresAt > nowDate.getTime();
  });
  if (index < 0) return null;

  const oldStatus = items[index].status || null;
  items[index] = {
    ...items[index],
    status: VERIFIED_STATUS,
    verifiedAt: items[index].verifiedAt || nowIso,
    verificationTokenHash: null,
    verificationTokenExpiresAt: nowIso,
    updatedAt: nowIso,
  };
  writeJsonArray(PRIVACY_REQUESTS_FILE, items);
  return { request: normalizeStoredRequest(items[index]), oldStatus, newStatus: VERIFIED_STATUS };
}

async function updatePrivacyRequest(id, updates) {
  const nowIso = new Date().toISOString();
  const safeUpdates = { ...updates, updatedAt: nowIso };

  if (isDbReady()) {
    try {
      const doc = await PrivacyRequest.findOne(buildMongoIdFilter(id));
      if (!doc) return null;
      const oldStatus = doc.status || null;
      for (const [key, value] of Object.entries(safeUpdates)) {
        doc[key] = value;
      }
      await doc.save();
      return { request: normalizeStoredRequest(doc), oldStatus, newStatus: doc.status || null };
    } catch (error) {
      console.warn('[dpdp][privacy-request][store] mongo update failed; falling back to file', error?.message || error);
    }
  }

  const items = readJsonArray(PRIVACY_REQUESTS_FILE);
  const index = findFileRequestIndex(items, id);
  if (index < 0) return null;
  const oldStatus = items[index].status || null;
  items[index] = { ...items[index], ...safeUpdates };
  writeJsonArray(PRIVACY_REQUESTS_FILE, items);
  return { request: normalizeStoredRequest(items[index]), oldStatus, newStatus: items[index].status || null };
}

async function createDpdpAuditLog(payload) {
  const timestamp = payload.timestamp || new Date();
  const doc = {
    requestId: String(payload.requestId || ''),
    action: String(payload.action || 'privacy_request_updated'),
    oldStatus: payload.oldStatus || null,
    newStatus: payload.newStatus || null,
    adminNote: payload.adminNote || null,
    handledBy: payload.handledBy || null,
    timestamp,
  };

  if (isDbReady()) {
    try {
      return normalizeStoredAuditLog(await DpdpAuditLog.create(doc));
    } catch (error) {
      console.warn('[dpdp][audit][store] mongo create failed; falling back to file', error?.message || error);
    }
  }

  const items = readJsonArray(DPDP_AUDIT_LOGS_FILE);
  items.push({ ...doc, timestamp: new Date(timestamp).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  writeJsonArray(DPDP_AUDIT_LOGS_FILE, items);
  return normalizeStoredAuditLog(items[items.length - 1]);
}

module.exports = {
  DATA_DIR,
  PRIVACY_REQUESTS_FILE,
  DPDP_AUDIT_LOGS_FILE,
  REQUEST_TYPE_VALUES,
  STATUS_VALUES,
  PENDING_EMAIL_VERIFICATION_STATUS,
  VERIFIED_STATUS,
  createPrivacyRequest,
  listPrivacyRequests,
  getPrivacyRequestById,
  verifyPrivacyRequestByTokenHash,
  updatePrivacyRequest,
  createDpdpAuditLog,
};
