const mongoose = require('mongoose');

const TermLockSchema = new mongoose.Schema(
  {
    term: { type: String, required: true, trim: true, index: true, unique: true },
    keepAs: {
      en: { type: String, default: undefined },
      hi: { type: String, default: undefined },
      gu: { type: String, default: undefined },
    },
    mode: { type: String, enum: ['LOCK', 'REPLACE'], default: 'LOCK' },
    enabled: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('TermLock', TermLockSchema);
