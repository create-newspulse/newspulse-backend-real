const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Plain token retained for backward compatibility (legacy records). New inserts must include tokenHash.
  token: { type: String },
  tokenHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  rotatedAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

// Unique index for hashed tokens (rotation creates new docs)
refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
// TTL index for expiry
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Hash helper
refreshTokenSchema.statics.hashToken = function(token) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(String(token)).digest('hex');
};

// Store a new refresh token (hashed)
refreshTokenSchema.statics.storeToken = async function(userId, token, expiresAt) {
  const hash = this.hashToken(token);
  return this.create({ user: userId, tokenHash: hash, token, expiresAt });
};

// Lookup by raw token value (hashed form)
refreshTokenSchema.statics.findByToken = function(token) {
  const hash = this.hashToken(token);
  return this.findOne({ tokenHash: hash });
};

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
