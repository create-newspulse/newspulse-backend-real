const path = require('path');

try {
  require('dotenv').config({ path: path.join(process.cwd(), '.env') });
} catch (_) {}

const DEFAULT_BASE = `http://localhost:${process.env.PORT || '5052'}`;
const baseUrl = String(process.env.BACKEND_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
const email = process.env.ADMIN_EMAIL || process.env.FOUNDER_EMAIL || 'admin@newspulse.ai';
const password = process.env.ADMIN_PASSWORD || process.env.FOUNDER_PASSWORD || process.env.ADMIN_PASS || 'Safe!2025@News';
const verifyCampaignName = 'Local Verify Sponsored Feature';

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text().catch(() => '');
  const json = text
    ? (() => {
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      })()
    : null;
  return { response, json };
}

async function login() {
  const { response, json } = await requestJson(`${baseUrl}/admin-api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok || !json || !json.token) {
    throw new Error(`Admin login failed (${response.status}): ${JSON.stringify(json)}`);
  }

  return json.token;
}

function buildPayload() {
  return {
    sponsorName: 'Local Verify Sponsor',
    internalCampaignName: verifyCampaignName,
    headline: 'Local verify Sponsored Feature',
    shortSummary: 'Local verification record for the homepage sponsored feature endpoint.',
    ctaText: 'Visit sponsor',
    destinationUrl: 'https://example.com/local-sponsored-feature',
    placement: 'homepage',
    coverImage: {
      url: 'https://images.unsplash.com/photo-1495020689067-958852a7765e?auto=format&fit=crop&w=1200&q=80',
      alt: 'Local verify sponsored feature',
    },
    isActive: true,
  };
}

async function upsertSponsoredFeature(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const list = await requestJson(`${baseUrl}/api/admin/sponsored-features`, {
    method: 'GET',
    headers,
  });

  if (!list.response.ok) {
    throw new Error(`List sponsored features failed (${list.response.status}): ${JSON.stringify(list.json)}`);
  }

  const existing = Array.isArray(list.json && list.json.items)
    ? list.json.items.find((item) => String(item && item.internalCampaignName || '').trim() === verifyCampaignName)
    : null;

  const payload = buildPayload();
  if (existing && existing.id) {
    const updated = await requestJson(`${baseUrl}/api/admin/sponsored-features/${existing.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    });
    if (!updated.response.ok) {
      throw new Error(`Update sponsored feature failed (${updated.response.status}): ${JSON.stringify(updated.json)}`);
    }
    return updated.json && updated.json.feature;
  }

  const created = await requestJson(`${baseUrl}/api/admin/sponsored-features`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!created.response.ok) {
    throw new Error(`Create sponsored feature failed (${created.response.status}): ${JSON.stringify(created.json)}`);
  }
  return created.json && created.json.feature;
}

async function verifyPublicEndpoint() {
  const { response, json } = await requestJson(`${baseUrl}/api/public/sponsored-feature?placement=homepage`);
  if (!response.ok) {
    throw new Error(`Public sponsored feature request failed (${response.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  const token = await login();
  const feature = await upsertSponsoredFeature(token);
  const publicPayload = await verifyPublicEndpoint();

  console.log(JSON.stringify({
    baseUrl,
    createdOrUpdatedFeatureId: feature && feature.id ? feature.id : null,
    publicFeature: publicPayload && publicPayload.feature ? publicPayload.feature : null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});