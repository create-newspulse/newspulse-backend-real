const axios = require('axios');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const net = require('net');

const { uploadFromBuffer, isCloudinaryConfigured } = require('../../lib/cloudinary');
const { AD_IMAGE_ACCEPTED_MIME_TYPES, assertAllowedAdImageUpload } = require('../../lib/mediaUploadValidation');

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

const ALLOWED_MIME_TYPES = new Set(AD_IMAGE_ACCEPTED_MIME_TYPES);

function isHttpUrl(url) {
  try {
    const u = new URL(String(url || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeContentType(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  return s.split(';')[0].trim();
}

function buildRemoteImageError(message, status = 400, code = 'REMOTE_IMAGE_REJECTED') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function normalizeHostname(hostname) {
  return String(hostname || '').trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function isPrivateHostname(hostname) {
  const host = normalizeHostname(hostname);
  return !host || host === 'localhost' || host.endsWith('.localhost');
}

function parseIpv4Bytes(address) {
  const parts = String(address || '').trim().split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (!bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return null;
  return bytes;
}

function getMappedIpv4FromIpv6(address) {
  const value = normalizeHostname(address).split('%')[0];
  const match = value.match(/^(?:0*:)*ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return match ? match[1] : '';
}

function isPrivateIpv4Address(address) {
  const bytes = parseIpv4Bytes(address);
  if (!bytes) return false;
  const [a, b, c] = bytes;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6Address(address) {
  const value = normalizeHostname(address).split('%')[0];
  if (!value) return true;
  const mappedIpv4 = getMappedIpv4FromIpv6(value);
  if (mappedIpv4) return isPrivateIpv4Address(mappedIpv4);
  if (value === '::' || value === '::1') return true;
  const firstHextet = parseInt(value.split(':')[0] || '0', 16);
  if (!Number.isFinite(firstHextet)) return true;
  if ((firstHextet & 0xfe00) === 0xfc00) return true;
  if ((firstHextet & 0xffc0) === 0xfe80) return true;
  if ((firstHextet & 0xff00) === 0xff00) return true;
  if (value.startsWith('2001:db8:') || value === '2001:db8::') return true;
  return false;
}

function isPrivateIpAddress(address) {
  const normalized = normalizeHostname(address).split('%')[0];
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4Address(normalized);
  if (family === 6) return isPrivateIpv6Address(normalized);
  return true;
}

function getLookup() {
  return global.__NEWS_PULSE_AD_IMAGE_LOOKUP__ || dns.lookup;
}

function getHttpClient() {
  return global.__NEWS_PULSE_AD_IMAGE_HTTP_CLIENT__ || axios;
}

async function resolveRemoteImageHost(hostname) {
  const host = normalizeHostname(hostname);
  if (isPrivateHostname(host)) {
    throw buildRemoteImageError('Remote image URL is not allowed', 400, 'UNSAFE_REMOTE_IMAGE_HOST');
  }

  const literalFamily = net.isIP(host);
  if (literalFamily) {
    if (isPrivateIpAddress(host)) {
      throw buildRemoteImageError('Remote image URL is not allowed', 400, 'UNSAFE_REMOTE_IMAGE_HOST');
    }
    return [{ address: host, family: literalFamily }];
  }

  let addresses;
  try {
    addresses = await getLookup()(host, { all: true, verbatim: true });
  } catch (_) {
    throw buildRemoteImageError('Remote image host could not be resolved', 400, 'REMOTE_IMAGE_DNS_FAILED');
  }

  const normalizedAddresses = Array.isArray(addresses)
    ? addresses.map((entry) => ({ address: normalizeHostname(entry?.address), family: entry?.family || net.isIP(entry?.address) }))
    : [];

  if (!normalizedAddresses.length || normalizedAddresses.some((entry) => !entry.address || isPrivateIpAddress(entry.address))) {
    throw buildRemoteImageError('Remote image URL is not allowed', 400, 'UNSAFE_REMOTE_IMAGE_HOST');
  }

  return normalizedAddresses;
}

async function assertSafeRemoteImageUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw buildRemoteImageError('imageUrl must be a valid http(s) URL', 400, 'INVALID_REMOTE_IMAGE_URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw buildRemoteImageError('imageUrl must be a valid http(s) URL', 400, 'INVALID_REMOTE_IMAGE_URL');
  }

  const addresses = await resolveRemoteImageHost(parsed.hostname);
  return { url: parsed, addresses };
}

function createPinnedLookup(addresses) {
  const pinned = addresses.map((entry) => ({ address: entry.address, family: entry.family || net.isIP(entry.address) }));
  return (hostname, options, callback) => {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    const family = typeof opts === 'number' ? opts : opts?.family;
    const candidates = family ? pinned.filter((entry) => entry.family === family) : pinned;
    const selected = candidates[0] || pinned[0];
    if (!selected || isPrivateIpAddress(selected.address)) {
      return cb(buildRemoteImageError('Remote image URL is not allowed', 400, 'UNSAFE_REMOTE_IMAGE_HOST'));
    }
    if (opts && typeof opts === 'object' && opts.all) return cb(null, candidates.length ? candidates : pinned);
    return cb(null, selected.address, selected.family);
  };
}

function createPinnedAgents(addresses) {
  const lookup = createPinnedLookup(addresses);
  return {
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup }),
  };
}

function safePublicId(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  // Keep only safe characters for Cloudinary public_id segments.
  return s
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

async function downloadImageToBuffer(url) {
  const u = String(url || '').trim();
  if (!isHttpUrl(u)) {
    throw buildRemoteImageError('imageUrl must be a valid http(s) URL', 400, 'INVALID_REMOTE_IMAGE_URL');
  }

  let res;
  let currentUrl = new URL(u);
  let redirectCount = 0;

  while (true) {
    const safeTarget = await assertSafeRemoteImageUrl(currentUrl.toString());
    const agents = createPinnedAgents(safeTarget.addresses);

    try {
      res = await getHttpClient().get(safeTarget.url.toString(), {
        responseType: 'arraybuffer',
        timeout: FETCH_TIMEOUT_MS,
        maxContentLength: MAX_BYTES,
        maxBodyLength: MAX_BYTES,
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
        httpAgent: agents.httpAgent,
        httpsAgent: agents.httpsAgent,
        proxy: false,
        headers: {
          // Some CDNs require a UA.
          'User-Agent': 'newspulse-backend/ads-image-ingest',
          Accept: 'image/*',
        },
      });
    } catch (e) {
      const tooLarge = String(e?.message || '').toLowerCase().includes('maxcontentlength') || String(e?.message || '').toLowerCase().includes('max body length');
      const msg = e?.code === 'ECONNABORTED'
        ? 'Timed out fetching image (10s)'
        : tooLarge
          ? 'Image too large (max 5MB)'
          : (e?.message || 'Failed to download image');
      const err = new Error(msg);
      err.status = tooLarge ? 413 : 400;
      throw err;
    }

    const status = Number(res?.status || 0);
    if (status >= 300 && status < 400) {
      if (redirectCount >= MAX_REDIRECTS) {
        throw buildRemoteImageError('Too many redirects while fetching image', 400, 'REMOTE_IMAGE_TOO_MANY_REDIRECTS');
      }
      const location = String(res?.headers?.location || '').trim();
      if (!location) throw buildRemoteImageError('Remote image redirect was invalid', 400, 'REMOTE_IMAGE_INVALID_REDIRECT');
      currentUrl = new URL(location, safeTarget.url);
      redirectCount += 1;
      continue;
    }

    break;
  }

  const contentType = normalizeContentType(res?.headers?.['content-type']);
  if (!ALLOWED_MIME_TYPES.has(contentType)) {
    const err = new Error(`Unsupported image type: ${contentType || 'unknown'}`);
    err.status = 400;
    throw err;
  }

  const buffer = Buffer.from(res.data);
  if (!buffer || buffer.length === 0) {
    const err = new Error('Downloaded image was empty');
    err.status = 400;
    throw err;
  }

  if (buffer.length > MAX_BYTES) {
    const err = new Error('Image too large (max 5MB)');
    err.status = 413;
    throw err;
  }

  assertAllowedAdImageUpload(contentType, buffer);

  return { buffer, contentType };
}

async function uploadBufferToCloudinary(buffer, _contentType, publicId) {
  if (!isCloudinaryConfigured()) {
    const err = new Error('Cloudinary is not configured');
    err.status = 500;
    err.code = 'CLOUDINARY_NOT_CONFIGURED';
    throw err;
  }

  const folder = String(process.env.ADS_IMAGE_FOLDER || 'ads').trim() || 'ads';
  const pid = safePublicId(publicId);
  const opts = {
    folder,
    ...(pid ? { publicId: pid } : {}),
  };

  const result = await uploadFromBuffer(buffer, opts);
  const url = result?.secure_url || result?.url || null;
  if (!url) {
    const err = new Error('Cloudinary upload failed');
    err.status = 500;
    throw err;
  }
  return url;
}

async function uploadAdImageFromUrl(url, adIdOrSlug) {
  const { buffer, contentType } = await downloadImageToBuffer(url);
  const pid = adIdOrSlug ? `ad-${String(adIdOrSlug)}` : '';
  return await uploadBufferToCloudinary(buffer, contentType, pid);
}

module.exports = {
  MAX_BYTES,
  FETCH_TIMEOUT_MS,
  MAX_REDIRECTS,
  ALLOWED_MIME_TYPES,
  assertSafeRemoteImageUrl,
  isHttpUrl,
  isPrivateHostname,
  isPrivateIpAddress,
  downloadImageToBuffer,
  uploadBufferToCloudinary,
  uploadAdImageFromUrl,
  safePublicId,
};
