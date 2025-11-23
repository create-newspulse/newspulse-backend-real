// scripts/test-threat-stats-founder.js
// Verifies /api/dashboard/threat-stats accessible to founder role via JWT.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');

async function run() {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  const token = jwt.sign({ sub: 'founder-001', email: 'founder@example.com', name: 'Founder', role: 'founder', type: 'access' }, secret, { expiresIn: '15m' });

  const unauth = await request(app).get('/api/dashboard/threat-stats');
  console.log('Unauth status (expected 401):', unauth.status);

  const auth = await request(app)
    .get('/api/dashboard/threat-stats')
    .set('Authorization', 'Bearer ' + token);
  console.log('Founder auth status (expected 200):', auth.status);
  if (auth.status === 200) {
    console.log('Payload keys:', Object.keys(auth.body));
  }
}

run().catch(e => { console.error(e); process.exit(1); });
