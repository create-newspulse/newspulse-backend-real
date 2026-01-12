// Quick test script for Public Site Settings API endpoints
// Uses Node's built-in fetch (Node 18+). This script is intentionally resilient:
// it logs failures but does not throw, so it won't break `node --test` runs.

const BASE_URL = 'http://localhost:5000';

// You'll need a valid admin token - update this or set ADMIN_TOKEN env var
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'your-admin-token-here';

async function httpJson(method, urlPath, body, token) {
  const url = `${BASE_URL}${urlPath}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }

  return { status: res.status, data };
}

async function testPublicEndpoints() {
  console.log('\n=== Testing Public Endpoints ===\n');

  try {
    const res = await httpJson('GET', '/api/public/settings');
    console.log('✓ GET /api/public/settings');
    console.log('  Status:', res.status);
    console.log('  Response:', JSON.stringify(res.data, null, 2));
  } catch (error) {
    console.error('✗ GET /api/public/settings failed:', error.message);
  }
}

async function testAdminEndpoints() {
  console.log('\n=== Testing Admin Endpoints ===\n');

  // Test 1: Get both draft and published
  try {
    const res = await httpJson('GET', '/api/admin/settings/public', null, ADMIN_TOKEN);
    console.log('✓ GET /api/admin/settings/public');
    console.log('  Status:', res.status);
    console.log('  Has draft:', !!res.data.draft);
    console.log('  Has published:', !!res.data.published);
  } catch (error) {
    console.error('✗ GET /api/admin/settings/public failed:', error.message);
  }

  // Test 2: Get draft only
  try {
    const res = await httpJson('GET', '/api/admin/settings/public/draft', null, ADMIN_TOKEN);
    console.log('\n✓ GET /api/admin/settings/public/draft');
    console.log('  Status:', res.status);
    console.log('  Has draft:', !!res.data.draft);
  } catch (error) {
    console.error('✗ GET /api/admin/settings/public/draft failed:', error.message);
  }

  // Test 3: Update draft
  try {
    const draftData = {
      homepage: {
        modules: {
          categoryStrip: { enabled: false, order: 1 },
          trendingStrip: { enabled: true, order: 2 },
        },
      },
      tickers: {
        breaking: {
          enabled: true,
          speedSeconds: 45,
          showWhenEmpty: true,
          mode: 'demo',
        },
      },
    };

    const res = await httpJson('PUT', '/api/admin/settings/public/draft', draftData, ADMIN_TOKEN);
    console.log('\n✓ PUT /api/admin/settings/public/draft');
    console.log('  Status:', res.status);
    console.log('  Draft updated:', res.data.message);
  } catch (error) {
    console.error('✗ PUT /api/admin/settings/public/draft failed:', error.message);
  }

  // Test 4: Publish draft
  try {
    const res = await httpJson('POST', '/api/admin/settings/public/publish', null, ADMIN_TOKEN);
    console.log('\n✓ POST /api/admin/settings/public/publish');
    console.log('  Status:', res.status);
    console.log('  Published:', res.data.message);
  } catch (error) {
    console.error('✗ POST /api/admin/settings/public/publish failed:', error.message);
  }

  // Test 5: Verify published settings changed
  try {
    const res = await httpJson('GET', '/api/public/settings');
    console.log('\n✓ Verifying published settings updated');
    console.log('  Category strip enabled:', res.data.published?.homepage?.modules?.categoryStrip?.enabled);
    console.log('  Breaking ticker speed:', res.data.published?.tickers?.breaking?.speedSeconds);
  } catch (error) {
    console.error('✗ Verification failed:', error.message);
  }
}

async function runTests() {
  console.log('Public Site Settings API Test\n');
  console.log('Server:', BASE_URL);
  console.log('Admin Token:', ADMIN_TOKEN ? '✓ Set' : '✗ Not set (admin tests will fail)');

  await testPublicEndpoints();

  if (ADMIN_TOKEN && ADMIN_TOKEN !== 'your-admin-token-here') {
    await testAdminEndpoints();
  } else {
    console.log('\n⚠ Skipping admin endpoint tests - no admin token provided');
    console.log('  Set ADMIN_TOKEN environment variable to test admin endpoints');
  }

  console.log('\n=== Tests Complete ===\n');
}

runTests().catch(console.error);
