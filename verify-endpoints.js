// verify-endpoints.js
// Quick verification script for Public Site Settings endpoints
// Usage: node verify-endpoints.js

const http = require('http');

function check(path, expectedStatus, label) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'localhost',
      port: 5000,
      path,
      method: 'GET',
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const ok = res.statusCode === expectedStatus;
        console.log(`${label}: ${ok ? '✅' : '❌'} (HTTP ${res.statusCode})`);
        if (!ok) console.log('  Response:', data);
        resolve(ok);
      });
    });
    req.on('error', (e) => {
      console.log(`${label}: ❌ (error)`, e.message);
      resolve(false);
    });
    req.end();
  });
}

(async () => {
  await check('/api/public/settings', 200, 'Public settings (should be 200)');
  await check('/api/admin/settings/public', 401, 'Admin settings (should be 401 w/o token)');
})();
