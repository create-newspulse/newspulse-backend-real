// routes/system/health.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const healthy = () => {
  const state = mongoose?.connection?.readyState; // 0=disconnected 1=connected 2=connecting 3=disconnecting
  return {
    ok: true,
    service: 'newspulse-backend-real',
    uptimeSec: Math.round(process.uptime()),
    ts: new Date().toISOString(),
    mongo: {
      connected: state === 1,
      state,
    },
  };
};

router.get('/', (_req, res) => {
  res.status(200).json(healthy());
});

router.head('/', (_req, res) => {
  res.sendStatus(200);
});

module.exports = router;
