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
  if (process.env.ADMIN_TOKEN) return String(process.env.ADMIN_TOKEN);

  const email = process.env.ADMIN_EMAIL || process.env.FOUNDER_EMAIL;
  const password = process.env.ADMIN_PASSWORD || process.env.FOUNDER_PASSWORD;
  if (!email || !password) return null;

  const res = await requestJson({
    method: 'POST',
    path: '/api/admin/login',
    body: { email, password },
  });

  const token = res && res.json && res.json.token ? String(res.json.token) : null;
  return token || null;
}

(async () => {
  await check('/api/public/settings', 200, 'Public settings (should be 200)');
  await check('/api/admin/settings/public', 401, 'Admin settings (should be 401 w/o token)');
  await check('/api/admin/team/users', 401, 'Team users (should be 401 w/o token)');
  await check('/api/admin/audit/logs', 401, 'Audit logs (should be 401 w/o token)');
  await check('/api/admin/security/session', 401, 'Security session (should be 401 w/o token)');

  const token = await getAdminToken();
  if (!token) {
    console.log('Team users (should be 200 w/ token): ⏭️  (skipped) Set ADMIN_TOKEN or ADMIN_EMAIL+ADMIN_PASSWORD');
    return;
  }

  await check('/api/admin/team/users', 200, 'Team users (should be 200 w/ token)', {
    headers: { Authorization: `Bearer ${token}` },
  });
})();
