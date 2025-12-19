const express = require('express');
const jwt = require('jsonwebtoken');

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const OwnerCredential = require('../models/OwnerCredential');
const { issueChallenge, consumeChallenge } = require('../lib/ownerPasskeyChallengeStore');
const { requireFounderAuth } = require('../middleware/adminAuth');

const router = express.Router();

function cookieOpts({ maxAgeMs } = {}) {
  const isProd = String(process.env.NODE_ENV).toLowerCase() === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    ...(typeof maxAgeMs === 'number' ? { maxAge: maxAgeMs } : {}),
  };
}

function parseCookies(header) {
  const cookies = {};
  (header || '').split(';').forEach((c) => {
    const [k, ...v] = c.trim().split('=');
    if (!k) return;
    cookies[k] = decodeURIComponent(v.join('=') || '');
  });
  return cookies;
}

function getPasskeyConfig() {
  const rpID = process.env.PASSKEY_RPID;
  const origin = process.env.PASSKEY_ORIGIN;
  if (!rpID || !origin) {
    throw new Error('PASSKEY_RPID and PASSKEY_ORIGIN must be set');
  }
  return { rpID, origin };
}

// Only the "founder" owner can register/auth.
const OWNER_ID = 'founder';

// POST /api/owner/passkey/register/options
router.post('/register/options', requireFounderAuth, async (req, res) => {
  try {
    const { rpID } = getPasskeyConfig();

    const existing = await OwnerCredential.find({ ownerId: OWNER_ID }).lean();

    const options = await generateRegistrationOptions({
      rpName: process.env.PASSKEY_RPNAME || 'NewsPulse Admin',
      rpID,
      userID: OWNER_ID,
      userName: String(process.env.FOUNDER_EMAIL || 'founder@newspulse.co.in'),
      attestationType: 'none',
      excludeCredentials: (existing || []).map((c) => ({
        id: c.credentialID,
        type: 'public-key',
        transports: c.transports || undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      supportedAlgorithmIDs: [-7, -257],
    });

    const challengeId = issueChallenge({ challenge: options.challenge, type: 'register', ownerId: OWNER_ID });
    res.cookie('owner_passkey_challenge', challengeId, cookieOpts({ maxAgeMs: 5 * 60 * 1000 }));

    return res.json({ ok: true, success: true, status: 200, data: { options } });
  } catch (e) {
    return res.status(500).json({ ok: false, success: false, status: 500, message: e?.message || 'Failed to create registration options' });
  }
});

// POST /api/owner/passkey/register/verify
router.post('/register/verify', requireFounderAuth, async (req, res) => {
  try {
    const { rpID, origin } = getPasskeyConfig();
    const cookies = parseCookies(req.headers.cookie || '');
    const challengeId = String(cookies.owner_passkey_challenge || '').trim();
    const row = consumeChallenge(challengeId, { type: 'register', ownerId: OWNER_ID });
    if (!row) {
      return res.status(400).json({ ok: false, success: false, status: 400, code: 'CHALLENGE_MISSING', message: 'Registration challenge missing or expired' });
    }

    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: row.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });

    const { verified, registrationInfo } = verification;
    if (!verified || !registrationInfo) {
      return res.status(400).json({ ok: false, success: false, status: 400, code: 'NOT_VERIFIED', message: 'Passkey registration could not be verified' });
    }

    const {
      credentialID,
      credentialPublicKey,
      counter,
      credentialDeviceType,
      credentialBackedUp,
    } = registrationInfo;

    const transports = (req.body && req.body.response && req.body.response.transports) ? req.body.response.transports : [];

    // Upsert by credentialID to prevent duplicates.
    await OwnerCredential.findOneAndUpdate(
      { credentialID },
      {
        $set: {
          ownerId: OWNER_ID,
          publicKey: credentialPublicKey,
          counter: Number(counter || 0),
          transports: Array.isArray(transports) ? transports : [],
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true, new: true },
    );

    return res.json({
      ok: true,
      success: true,
      status: 200,
      data: {
        verified: true,
        credentialDeviceType,
        credentialBackedUp,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, success: false, status: 500, message: e?.message || 'Failed to verify registration' });
  }
});

// POST /api/owner/passkey/auth/options
router.post('/auth/options', requireFounderAuth, async (req, res) => {
  try {
    const { rpID } = getPasskeyConfig();
    const creds = await OwnerCredential.find({ ownerId: OWNER_ID }).lean();
    if (!creds || creds.length === 0) {
      return res.status(400).json({ ok: false, success: false, status: 400, code: 'NO_PASSKEYS', message: 'No passkeys registered yet' });
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({
        id: c.credentialID,
        type: 'public-key',
        transports: c.transports || undefined,
      })),
    });

    const challengeId = issueChallenge({ challenge: options.challenge, type: 'auth', ownerId: OWNER_ID });
    res.cookie('owner_passkey_challenge', challengeId, cookieOpts({ maxAgeMs: 5 * 60 * 1000 }));

    return res.json({ ok: true, success: true, status: 200, data: { options } });
  } catch (e) {
    return res.status(500).json({ ok: false, success: false, status: 500, message: e?.message || 'Failed to create auth options' });
  }
});

// POST /api/owner/passkey/auth/verify
router.post('/auth/verify', requireFounderAuth, async (req, res) => {
  try {
    const { rpID, origin } = getPasskeyConfig();
    const cookies = parseCookies(req.headers.cookie || '');
    const challengeId = String(cookies.owner_passkey_challenge || '').trim();
    const row = consumeChallenge(challengeId, { type: 'auth', ownerId: OWNER_ID });
    if (!row) {
      return res.status(400).json({ ok: false, success: false, status: 400, code: 'CHALLENGE_MISSING', message: 'Auth challenge missing or expired' });
    }

    const body = req.body || {};
    const credIdB64Url = body && body.id ? String(body.id) : '';
    if (!credIdB64Url) {
      return res.status(400).json({ ok: false, success: false, status: 400, code: 'MISSING_CREDENTIAL_ID', message: 'Missing credential id' });
    }

    const credentialID = Buffer.from(credIdB64Url, 'base64url');
    const authenticator = await OwnerCredential.findOne({ ownerId: OWNER_ID, credentialID });
    if (!authenticator) {
      return res.status(400).json({ ok: false, success: false, status: 400, code: 'UNKNOWN_CREDENTIAL', message: 'Unknown credential' });
    }

    const verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: row.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      authenticator: {
        credentialID: authenticator.credentialID,
        credentialPublicKey: authenticator.publicKey,
        counter: authenticator.counter,
        transports: authenticator.transports || undefined,
      },
    });

    const { verified, authenticationInfo } = verification;
    if (!verified || !authenticationInfo) {
      return res.status(401).json({ ok: false, success: false, status: 401, code: 'NOT_VERIFIED', message: 'Passkey auth could not be verified' });
    }

    // Update signature counter
    await OwnerCredential.updateOne(
      { _id: authenticator._id },
      { $set: { counter: authenticationInfo.newCounter } },
    );

    // Issue 10-minute owner key token as httpOnly secure cookie
    const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
    const ownerKey = jwt.sign({ sub: OWNER_ID, type: 'owner_key' }, secret, { expiresIn: '10m' });
    res.cookie('owner_key', ownerKey, cookieOpts({ maxAgeMs: 10 * 60 * 1000 }));

    return res.json({ ok: true, success: true, status: 200, data: { verified: true, unlockedForSeconds: 600 } });
  } catch (e) {
    return res.status(500).json({ ok: false, success: false, status: 500, message: e?.message || 'Failed to verify authentication' });
  }
});

module.exports = router;
