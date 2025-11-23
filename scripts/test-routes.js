// scripts/test-routes.js
// Lightweight verification of newly added stub endpoints without binding a port.
// Uses supertest against exported Express app instance.

const request = require('supertest');
const app = require('../server');

async function run() {
  const results = [];

  // Unauthorized threat-stats should 401
  const unauthThreat = await request(app).get('/api/dashboard/threat-stats');
  results.push({ endpoint: '/api/dashboard/threat-stats (no auth)', status: unauthThreat.status });

  // Authorized threat-stats
  const threat = await request(app)
    .get('/api/dashboard/threat-stats')
    .set('Cookie', 'np_admin=admin%40newspulse.ai');
  results.push({ endpoint: '/api/dashboard/threat-stats', status: threat.status, body: threat.body });

  // Alerts settings unauthorized should 401
  const unauthAlerts = await request(app).get('/api/alerts/settings');
  results.push({ endpoint: '/api/alerts/settings (no auth)', status: unauthAlerts.status });

  // Alerts settings authorized
  const alerts = await request(app)
    .get('/api/alerts/settings')
    .set('Cookie', 'np_admin=admin%40newspulse.ai');
  results.push({ endpoint: '/api/alerts/settings', status: alerts.status, body: alerts.body });

  // Security threat-scan status (authorized)
  const threatScan = await request(app)
    .get('/api/security/threat-scan')
    .set('Cookie', 'np_admin=admin%40newspulse.ai');
  results.push({ endpoint: '/api/security/threat-scan', status: threatScan.status, body: threatScan.body });

  console.log('\nRoute Test Summary');
  for (const r of results) {
    console.log(`${r.endpoint} -> ${r.status}`);
  }

  // Basic shape assertions (non-throwing; just log mismatches)
  function assert(condition, msg) { if (!condition) console.warn('ASSERT FAIL:', msg); }

  assert(threat.status === 200, 'Threat stats should be 200');
  assert(threat.body && threat.body.ok, 'Threat stats body.ok true');
  assert(alerts.status === 200, 'Alerts settings should be 200');
  assert(alerts.body && alerts.body.channels, 'Alerts settings channels present');

  console.log('\nSample threat-stats payload keys:', Object.keys(threat.body));
  console.log('Sample alerts settings payload keys:', Object.keys(alerts.body));
}

run().catch(e => {
  console.error('Test run failed', e);
  process.exit(1);
});
