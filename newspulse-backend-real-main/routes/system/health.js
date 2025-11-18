// routes/system/health.js
// Minimal JSON health endpoint for monitoring and the admin panel.

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

function buildPayload() {
  const state = typeof mongoose?.connection?.readyState === 'number' ? mongoose.connection.readyState : -1;
  const connected = state === 1; // 1: connected, 2: connecting, 0: disconnected, 3: disconnecting
  return {
    ok: true,
    service: 'newspulse-backend-real',
    uptimeSec: Math.floor(process.uptime()),
    ts: new Date().toISOString(),
    mongo: {
      connected,
      state,
    },
  };
}

router.get('/', (_req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.status(200).json(buildPayload());
});

router.head('/', (_req, res) => {
  // Fast head response for warm-ups
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.sendStatus(200);
});

module.exports = router;
