const crypto = require('node:crypto');

function _isConfigured() {
  return Boolean(String(process.env.AWS_ACCESS_KEY_ID || '').trim()) &&
    Boolean(String(process.env.AWS_SECRET_ACCESS_KEY || '').trim()) &&
    Boolean(String(process.env.AWS_REGION || '').trim());
}

function _hmac(key, data, encoding) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest(encoding);
}

function _sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function _amzDate(now) {
  const d = now instanceof Date ? now : new Date();
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const HH = String(d.getUTCHours()).padStart(2, '0');
  const MM = String(d.getUTCMinutes()).padStart(2, '0');
  const SS = String(d.getUTCSeconds()).padStart(2, '0');
  return {
    short: `${yyyy}${mm}${dd}`,
    long: `${yyyy}${mm}${dd}T${HH}${MM}${SS}Z`,
  };
}

function _getSignatureKey(secretAccessKey, dateStamp, regionName, serviceName) {
  const kDate = _hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = _hmac(kDate, regionName);
  const kService = _hmac(kRegion, serviceName);
  const kSigning = _hmac(kService, 'aws4_request');
  return kSigning;
}

async function translate({ text, sourceLang, targetLang }) {
  const accessKeyId = String(process.env.AWS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(process.env.AWS_SECRET_ACCESS_KEY || '').trim();
  const region = String(process.env.AWS_REGION || '').trim();
  const sessionToken = String(process.env.AWS_SESSION_TOKEN || '').trim();

  if (!accessKeyId) return { ok: false, engine: 'AWS', status: 'BLOCKED', reasons: ['MISSING_AWS_ACCESS_KEY_ID'] };
  if (!secretAccessKey) return { ok: false, engine: 'AWS', status: 'BLOCKED', reasons: ['MISSING_AWS_SECRET_ACCESS_KEY'] };
  if (!region) return { ok: false, engine: 'AWS', status: 'BLOCKED', reasons: ['MISSING_AWS_REGION'] };

  const bodyObj = {
    Text: String(text || ''),
    SourceLanguageCode: String(sourceLang || '').trim().toLowerCase(),
    TargetLanguageCode: String(targetLang || '').trim().toLowerCase(),
  };
  const requestBody = JSON.stringify(bodyObj);

  const service = 'translate';
  const host = `translate.${region}.amazonaws.com`;
  const endpoint = `https://${host}/`;

  const now = new Date();
  const amz = _amzDate(now);

  const method = 'POST';
  const canonicalUri = '/';
  const canonicalQuerystring = '';
  const contentType = 'application/x-amz-json-1.1';
  const target = 'AWSMachineTranslationService.TranslateText';

  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-date:${amz.long}\n` +
    `x-amz-target:${target}\n` +
    (sessionToken ? `x-amz-security-token:${sessionToken}\n` : '');

  const signedHeaders = sessionToken
    ? 'content-type;host;x-amz-date;x-amz-security-token;x-amz-target'
    : 'content-type;host;x-amz-date;x-amz-target';

  const payloadHash = _sha256Hex(requestBody);
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${amz.short}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amz.long,
    credentialScope,
    _sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = _getSignatureKey(secretAccessKey, amz.short, region, service);
  const signature = _hmac(signingKey, stringToSign, 'hex');

  const authorizationHeader =
    `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    'Content-Type': contentType,
    'X-Amz-Date': amz.long,
    'X-Amz-Target': target,
    Authorization: authorizationHeader,
  };
  if (sessionToken) headers['X-Amz-Security-Token'] = sessionToken;

  try {
    const res = await fetch(endpoint, { method: 'POST', headers, body: requestBody });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, engine: 'AWS', status: 'BLOCKED', reasons: ['AWS_HTTP_ERROR'], details: json || null };
    }

    const translatedText = json && typeof json.TranslatedText === 'string' ? json.TranslatedText : '';
    if (!translatedText.trim()) {
      return { ok: false, engine: 'AWS', status: 'BLOCKED', reasons: ['AWS_EMPTY_OUTPUT'] };
    }

    return { ok: true, engine: 'AWS', text: translatedText };
  } catch (e) {
    return { ok: false, engine: 'AWS', status: 'BLOCKED', reasons: ['AWS_NETWORK_ERROR'], details: e?.message || String(e) };
  }
}

module.exports = {
  name: 'AWS',
  isConfigured: _isConfigured,
  translate,
};
