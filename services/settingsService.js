const mongoose = require('mongoose');

const SystemSetting = require('../models/SystemSetting');
const SettingsVersion = require('../models/SettingsVersion');
const AuditLog = require('../models/AuditLog');

const DEFAULTS = {
  'site.readOnlyMode': false,
};

const LOCKDOWN_PREFIXES = [
  'security.',
  'lockdown.',
  'safezone.',
  'ops.',
];

function isLockdownSettingKey(key) {
  if (!key) return false;
  if (key === 'site.readOnlyMode') return true;
  return LOCKDOWN_PREFIXES.some((p) => key.startsWith(p));
}

function toActor(admin) {
  const a = admin || {};
  return {
    id: a.id || null,
    email: a.email || null,
    role: a.role || null,
  };
}

function normalizeKey(key) {
  return String(key || '').trim();
}

class SettingsService {
  constructor() {
    this._cache = new Map(); // key -> { value, updatedAt }
    this._cacheLoadedAt = 0;
    this._cacheTtlMs = 5_000;
    this._loadPromise = null;
  }

  async _loadAllToCache() {
    const now = Date.now();
    if (now - this._cacheLoadedAt < this._cacheTtlMs && this._cache.size > 0) return;
    if (this._loadPromise) return this._loadPromise;

    this._loadPromise = (async () => {
      const docs = await SystemSetting.find({}).lean();
      this._cache.clear();
      for (const d of docs) {
        this._cache.set(d.key, { value: d.value, updatedAt: d.updatedAt || null });
      }
      this._cacheLoadedAt = Date.now();
    })();

    try {
      await this._loadPromise;
    } finally {
      this._loadPromise = null;
    }
  }

  async list(prefix = '') {
    const p = String(prefix || '').trim();
    if (!p) {
      await this._loadAllToCache();
      const items = [];
      for (const [key, entry] of this._cache.entries()) {
        items.push({ key, value: entry.value, updatedAt: entry.updatedAt });
      }
      return items.sort((a, b) => a.key.localeCompare(b.key));
    }

    // Query directly for prefix to avoid loading everything.
    const regex = new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const docs = await SystemSetting.find({ key: { $regex: regex } }).sort({ key: 1 }).lean();
    return docs.map((d) => ({ key: d.key, value: d.value, updatedAt: d.updatedAt || null }));
  }

  async get(key, { defaultValue } = {}) {
    const k = normalizeKey(key);
    if (!k) return defaultValue;

    try {
      await this._loadAllToCache();
      if (this._cache.has(k)) return this._cache.get(k).value;
    } catch (e) {
      // If DB is offline, fall back to defaults
    }

    if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) return DEFAULTS[k];
    return defaultValue;
  }

  async set(key, value, { admin, ip, userAgent, action = 'set', meta } = {}) {
    const k = normalizeKey(key);
    if (!k) throw new Error('Missing setting key');

    const actor = toActor(admin);

    const beforeDoc = await SystemSetting.findOne({ key: k }).lean();
    const beforeVal = beforeDoc ? beforeDoc.value : (Object.prototype.hasOwnProperty.call(DEFAULTS, k) ? DEFAULTS[k] : null);

    const doc = await SystemSetting.findOneAndUpdate(
      { key: k },
      {
        $set: { value, updatedBy: actor },
        $setOnInsert: { key: k },
      },
      { upsert: true, new: true, setDefaultsOnInsert: false },
    );

    // Update cache
    this._cache.set(k, { value: doc.value, updatedAt: doc.updatedAt });
    this._cacheLoadedAt = Date.now();

    await AuditLog.create({
      action,
      key: k,
      before: beforeVal,
      after: value,
      actor,
      ip: ip || null,
      userAgent: userAgent || null,
      meta: meta || null,
    });

    return { key: k, value: doc.value, updatedAt: doc.updatedAt };
  }

  async batchSet(items, { admin, ip, userAgent } = {}) {
    if (!Array.isArray(items)) throw new Error('items must be an array');

    const results = [];
    for (const item of items) {
      const k = normalizeKey(item && item.key);
      if (!k) continue;
      const val = item.value;
      const r = await this.set(k, val, { admin, ip, userAgent, action: 'batch_set' });
      results.push(r);
    }
    return results;
  }

  async createSnapshot({ admin, ip, userAgent, note = '' } = {}) {
    const actor = toActor(admin);

    const settingsDocs = await SystemSetting.find({}).lean();
    const snapshot = {};
    for (const d of settingsDocs) snapshot[d.key] = d.value;
    // Ensure defaults are present in snapshot even if not stored
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, k)) snapshot[k] = v;
    }

    // Allocate next version (retry on rare races)
    let version = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const last = await SettingsVersion.findOne({}).sort({ version: -1 }).lean();
      const next = (last && typeof last.version === 'number') ? (last.version + 1) : 1;
      try {
        const created = await SettingsVersion.create({ version: next, snapshot, note: String(note || ''), createdBy: actor });
        version = created.version;
        break;
      } catch (e) {
        if (e && e.code === 11000) continue;
        throw e;
      }
    }
    if (version == null) throw new Error('Failed to allocate snapshot version');

    await AuditLog.create({
      action: 'snapshot',
      key: null,
      before: null,
      after: { version },
      actor,
      ip: ip || null,
      userAgent: userAgent || null,
      meta: { note: String(note || ''), keys: Object.keys(snapshot).length },
    });

    return { version, keys: Object.keys(snapshot).length };
  }

  async rollbackToVersion(versionRaw, { admin, ip, userAgent } = {}) {
    const version = parseInt(String(versionRaw), 10);
    if (!Number.isFinite(version) || version <= 0) throw new Error('Invalid version');

    const actor = toActor(admin);
    const verDoc = await SettingsVersion.findOne({ version }).lean();
    if (!verDoc) {
      const err = new Error('Version not found');
      err.code = 'VERSION_NOT_FOUND';
      throw err;
    }

    const snapshot = verDoc.snapshot || {};

    const currentDocs = await SystemSetting.find({}).lean();
    const currentMap = {};
    for (const d of currentDocs) currentMap[d.key] = d.value;

    const ops = [];
    // Upsert snapshot keys
    for (const [k, v] of Object.entries(snapshot)) {
      ops.push({
        updateOne: {
          filter: { key: k },
          update: { $set: { key: k, value: v, updatedBy: actor } },
          upsert: true,
        },
      });
    }

    // Delete keys not present in snapshot to restore exact state
    const snapshotKeys = new Set(Object.keys(snapshot));
    const deleteKeys = Object.keys(currentMap).filter((k) => !snapshotKeys.has(k));
    if (deleteKeys.length > 0) {
      ops.push({ deleteMany: { filter: { key: { $in: deleteKeys } } } });
    }

    if (ops.length > 0) await SystemSetting.bulkWrite(ops, { ordered: false });

    // Refresh cache in-memory
    this._cacheLoadedAt = 0;
    await this._loadAllToCache();

    // Per-key audit logs (before/after)
    const auditDocs = [];
    for (const [k, afterVal] of Object.entries(snapshot)) {
      const beforeVal = Object.prototype.hasOwnProperty.call(currentMap, k)
        ? currentMap[k]
        : (Object.prototype.hasOwnProperty.call(DEFAULTS, k) ? DEFAULTS[k] : null);
      if (JSON.stringify(beforeVal) === JSON.stringify(afterVal)) continue;
      auditDocs.push({
        action: 'rollback_set',
        key: k,
        before: beforeVal,
        after: afterVal,
        actor,
        ip: ip || null,
        userAgent: userAgent || null,
        meta: { version },
      });
    }
    for (const k of deleteKeys) {
      auditDocs.push({
        action: 'rollback_delete',
        key: k,
        before: currentMap[k],
        after: null,
        actor,
        ip: ip || null,
        userAgent: userAgent || null,
        meta: { version },
      });
    }
    if (auditDocs.length) await AuditLog.insertMany(auditDocs);

    await AuditLog.create({
      action: 'rollback',
      key: null,
      before: null,
      after: { version },
      actor,
      ip: ip || null,
      userAgent: userAgent || null,
      meta: { version, changed: auditDocs.length, deleted: deleteKeys.length },
    });

    return { version, changed: auditDocs.length, deleted: deleteKeys.length };
  }
}

module.exports = {
  settingsService: new SettingsService(),
  isLockdownSettingKey,
};
