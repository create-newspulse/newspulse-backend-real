// lib/logThrottle.js
// Simple in-memory log rate limiter to suppress noisy repeated logs.
// Usage:
//   const { shouldLog } = require('./lib/logThrottle');
//   if (shouldLog('some.unique.key', 60000)) console.warn('message');

const lastLogMap = new Map();

function now() {
  return Date.now();
}

function shouldLog(key, intervalMs) {
  try {
    const ts = lastLogMap.get(key) || 0;
    const n = now();
    if (n - ts >= intervalMs) {
      lastLogMap.set(key, n);
      return true;
    }
    return false;
  } catch (_) {
    // If anything goes wrong, allow logging to avoid hiding important info
    return true;
  }
}

module.exports = { shouldLog };
