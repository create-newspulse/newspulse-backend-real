const allowedFields = new Set([
  'stage', 'phase', 'method', 'status', 'statusCode', 'returnedStatusCode', 'code', 'backendCode', 'reason',
  'provider', 'scope', 'elapsedMs', 'durationMs', 'traceId', 'requestId', 'productionLike', 'renderLike',
  'configured', 'sent', 'success', 'ok', 'verified', 'sessionPresent', 'challengeSessionPresent',
  'authModel', 'recordFound', 'challengeFound', 'expired', 'consumed', 'remaining', 'attempt',
  'hasJwtSecret', 'baseUrlConfigured', 'secureRequest', 'compatRequest', 'ts',
  'sendMethod', 'action', 'requestBurstDuplicate', 'requestBurstCount',
]);

function safeSecurityLog(details) {
  const result = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (!allowedFields.has(key)) continue;
    if (typeof value === 'boolean' || typeof value === 'number' || value === null) result[key] = value;
    else if (typeof value === 'string' && value.length <= 100 && /^[a-zA-Z0-9_.:\- ]+$/.test(value)) {
      if (key === 'code' && /^\d{6}$/.test(value)) continue;
      result[key] = value;
    }
  }
  return result;
}

module.exports = { safeSecurityLog };