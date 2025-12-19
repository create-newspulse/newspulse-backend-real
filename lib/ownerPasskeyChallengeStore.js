const crypto = require('crypto');

// Ephemeral, in-memory challenge store.
// Keyed by a random challengeId stored in an httpOnly cookie.
const _challenges = new Map();

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

function _now() {
  return Date.now();
}

function _cleanup() {
  const now = _now();
  for (const [k, v] of _challenges.entries()) {
    if (!v || !v.expiresAt || v.expiresAt <= now) _challenges.delete(k);
  }
}

function issueChallenge({ challenge, type, ownerId = 'founder', ttlMs = DEFAULT_TTL_MS }) {
  _cleanup();
  const challengeId = crypto.randomBytes(24).toString('base64url');
  _challenges.set(challengeId, {
    challenge,
    type,
    ownerId,
    expiresAt: _now() + ttlMs,
  });
  return challengeId;
}

function consumeChallenge(challengeId, { type, ownerId = 'founder' } = {}) {
  _cleanup();
  const row = _challenges.get(challengeId);
  if (!row) return null;
  if (type && row.type !== type) return null;
  if (ownerId && row.ownerId !== ownerId) return null;
  _challenges.delete(challengeId);
  return row;
}

function peekChallenge(challengeId) {
  _cleanup();
  return _challenges.get(challengeId) || null;
}

module.exports = {
  issueChallenge,
  consumeChallenge,
  peekChallenge,
};
