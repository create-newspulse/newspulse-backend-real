// verify-endpoints.js
// Quick verification script for Public Site Settings endpoints
// Usage: node verify-endpoints.js

const http = require('http');

function requestJson({ method, path, headers, body }) {
  return new Promise((resolve) => {
    const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      hostname: 'localhost',
      port: 5000,
      path,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(headers || {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) {}
        resolve({ status: res.statusCode, raw: data, json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, raw: e.message, json: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

function check(path, expectedStatus, label, { headers } = {}) {
  return new Promise((resolve) => {
    requestJson({ method: 'GET', path, headers }).then((res) => {
      const ok = res.status === expectedStatus;
      console.log(`${label}: ${ok ? '✅' : '❌'} (HTTP ${res.status})`);
      if (!ok) console.log('  Response:', res.raw);
      resolve(ok);
    });
  });
}

async function getAdminToken() {
  if (process.env.ADMIN_TOKEN) return { token: String(process.env.ADMIN_TOKEN), role: 'unknown' };

  const email = process.env.FOUNDER_EMAIL || process.env.ADMIN_EMAIL;
  const password = process.env.FOUNDER_PASSWORD || process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS;
  if (!email || !password) return null;

  // Prefer DB-backed JWT login.
  const authRes = await requestJson({ method: 'POST', path: '/api/auth/login', body: { email, password } });
  const authToken = authRes && authRes.json && authRes.json.token ? String(authRes.json.token) : null;
  const authRole = authRes && authRes.json && authRes.json.user && authRes.json.user.role ? String(authRes.json.user.role) : null;
  if (authToken) return { token: authToken, role: authRole || 'unknown' };

  // Fallback: legacy founder login endpoint used by some admin panels.
  const adminRes = await requestJson({ method: 'POST', path: '/api/admin/login', body: { email, password } });
  const adminToken = adminRes && adminRes.json && adminRes.json.token ? String(adminRes.json.token) : null;
  const adminRole = adminRes && adminRes.json && adminRes.json.user && adminRes.json.user.role ? String(adminRes.json.user.role) : null;
  if (adminToken) return { token: adminToken, role: adminRole || 'unknown' };

  return null;
}

(async () => {
  await check('/api/public/settings', 200, 'Public settings (should be 200)');
  await check('/api/admin/settings/public', 401, 'Admin settings (should be 401 w/o token)');
  await check('/api/admin/team/users', 401, 'Team users (should be 401 w/o token)');
  await check('/admin-api/admin/team/users', 401, 'Team users alias (should be 401 w/o token)');
  await check('/api/admin/audit?limit=1', 401, 'Audit (should be 401 w/o token)');
  await check('/admin-api/admin/audit?limit=1', 401, 'Audit alias (should be 401 w/o token)');
  await check('/api/admin/audit/logs', 401, 'Audit logs legacy (should be 401 w/o token)');
  await check('/api/admin/security/session', 401, 'Security session (should be 401 w/o token)');
  await check('/api/admin/settings/preview?state=effective', 401, 'Settings preview (should be 401 w/o token)');
  await check('/api/admin/settings/admin-panel/preview?state=effective', 401, 'Admin panel preview (should be 401 w/o token)');

  // Owner bootstrap endpoint (should be 401 without key, 200 with key)
  const ownerKey = String(process.env.OWNER_BOOTSTRAP_KEY || '').trim();
  if (ownerKey) {
    const noKeyRes = await requestJson({
      method: 'POST',
      path: '/api/admin/bootstrap-founder',
      body: { email: 'bootstrap@example.com', password: 'Password123!', fullName: 'Bootstrap Founder' },
    });
    console.log(`Bootstrap founder (no key): ${noKeyRes.status === 401 ? '✅' : '❌'} (HTTP ${noKeyRes.status})`);

    const withKeyRes = await requestJson({
      method: 'POST',
      path: '/api/admin/bootstrap-founder',
      headers: { 'x-owner-key': ownerKey },
      body: { email: 'bootstrap@example.com', password: 'Password123!', fullName: 'Bootstrap Founder' },
    });
    console.log(`Bootstrap founder (with key): ${withKeyRes.status === 200 ? '✅' : '❌'} (HTTP ${withKeyRes.status})`);
    if (withKeyRes.status !== 200) console.log('  Response:', withKeyRes.raw);
  } else {
    console.log('[SKIP] OWNER_BOOTSTRAP_KEY not set; skipping bootstrap-founder checks');
  }

  const auth = await getAdminToken();
  if (!auth || !auth.token) {
    console.log('Team users (should be 200 w/ token): ⏭️  (skipped) Set ADMIN_TOKEN or ADMIN_EMAIL+ADMIN_PASSWORD');
    return;
  }

  if (String(auth.role || '').toLowerCase() !== 'founder') {
    console.log(`Founder-only checks: ⏭️  (skipped) Logged in as role=${auth.role}`);
    return;
  }

  const token = auth.token;

  await check('/api/admin/team/users', 200, 'Team users (should be 200 w/ token)', {
    headers: { Authorization: `Bearer ${token}` },
  });

  await check('/admin-api/admin/team/users', 200, 'Team users alias (should be 200 w/ token)', {
    headers: { Authorization: `Bearer ${token}` },
  });

  await check('/api/admin/settings/admin-panel/preview?state=effective', 200, 'Admin panel preview (should be 200 w/ token)', {
    headers: { Authorization: `Bearer ${token}` },
  });

  await check('/api/admin/settings/preview?state=effective', 200, 'Settings preview (should be 200 w/ token)', {
    headers: { Authorization: `Bearer ${token}` },
  });

  await check('/api/admin/audit?limit=1', 200, 'Audit (should be 200 w/ token)', {
    headers: { Authorization: `Bearer ${token}` },
  });

  await check('/admin-api/admin/audit?limit=1', 200, 'Audit alias (should be 200 w/ token)', {
    headers: { Authorization: `Bearer ${token}` },
  });
})();
