// scripts/test-community-submission.js
// Quick supertest-based checks for community submission endpoint
const request = require('supertest');
const app = require('../server');

async function run() {
  const results = [];

  // Valid payload
  const valid = await request(app)
    .post('/api/community/submissions')
    .send({
      name: 'Test Reporter',
      email: 'reporter@example.com',
      location: 'Mumbai, IN',
      ageGroup: '25–40',
      category: 'other',
      headline: 'Sample Headline',
      story: 'This is a valid story body',
      mediaLink: 'https://example.com/photo.jpg',
      acceptTerms: true,
    })
    .set('Content-Type', 'application/json');
  results.push({ test: 'valid payload', status: valid.status, body: valid.body });

  // Missing required fields
  const invalid = await request(app)
    .post('/api/community/submissions')
    .send({
      name: '',
      email: '',
      headline: '',
      story: '',
      acceptTerms: false,
    })
    .set('Content-Type', 'application/json');
  results.push({ test: 'missing required', status: invalid.status, body: invalid.body });

  console.log('\nCommunity Submission Test Summary');
  for (const r of results) {
    console.log(`${r.test} -> ${r.status}`, r.body);
  }

  // Basic assertions
  function assert(cond, msg){ if (!cond) console.warn('ASSERT FAIL:', msg); }
  assert(valid.status === 201, 'Valid should return 201');
  assert(valid.body && valid.body.ok && valid.body.submissionId, 'Valid response shape');
  assert(invalid.status === 400, 'Invalid should return 400');
  assert(invalid.body && invalid.body.error === 'invalid_payload', 'Invalid error shape');
}

run().catch(e => {
  console.error('Community tests failed', e);
  process.exit(1);
});
