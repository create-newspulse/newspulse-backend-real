const mongoose = require('mongoose');

// Stores passkeys for the single "founder" owner.
// We store credentialID and publicKey as Buffer for efficient binary storage.
const OwnerCredentialSchema = new mongoose.Schema(
  {
    ownerId: { type: String, required: true, index: true, default: 'founder' },
    credentialID: { type: Buffer, required: true, unique: true, index: true },
    publicKey: { type: Buffer, required: true },
    counter: { type: Number, required: true, default: 0 },
    transports: { type: [String], default: [] },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } },
);

module.exports = mongoose.models.OwnerCredential || mongoose.model('OwnerCredential', OwnerCredentialSchema);
