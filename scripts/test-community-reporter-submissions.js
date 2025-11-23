// scripts/test-community-reporter-submissions.js
// Verifies /admin/community-reporter/submissions auth behavior.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');

async function run() {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-me';
  const founderToken = jwt.sign({ sub: 'founder-001', email: 'founder@example.com', name: 'Founder', role: 'founder', type: 'access' }, secret, { expiresIn: '15m' });
  const adminToken = jwt.sign({ sub: 'admin-001', email: 'admin@example.com', name: 'Admin', role: 'admin', type: 'access' }, secret, { expiresIn: '15m' });
  const badRoleToken = jwt.sign({ sub: 'user-001', email: 'user@example.com', name: 'User', role: 'user', type: 'access' }, secret, { expiresIn: '15m' });

  const unauth = await request(app).get('/admin/community-reporter/submissions');
  console.log('Unauth status (expected 401):', unauth.status);

  const founderAuth = await request(app)
    .get('/admin/community-reporter/submissions')
    .set('Authorization', 'Bearer ' + founderToken);
  console.log('Founder status (expected 200):', founderAuth.status);
  console.log('Founder body keys:', Object.keys(founderAuth.body));

  const adminAuth = await request(app)
    .get('/admin/community-reporter/submissions')
    .set('Authorization', 'Bearer ' + adminToken);
  console.log('Admin status (expected 200):', adminAuth.status);

  const badRole = await request(app)
    .get('/admin/community-reporter/submissions')
    .set('Authorization', 'Bearer ' + badRoleToken);
  console.log('Bad role status (expected 403):', badRole.status);
}

run().catch(e => { console.error(e); process.exit(1); });
