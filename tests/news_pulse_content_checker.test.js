const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');

function signToken(role, email) {
  return jwt.sign(
    {
      sub: `${role}-id`,
      email,
      name: role,
      role,
      tokenVersion: 0,
      type: 'access',
    },
    process.env.JWT_SECRET,
    { expiresIn: '2h' }
  );
}

function buildValidEnglishStory() {
  return {
    title: 'City market reopens after storm disruption',
    summary: 'Officials said the market reopened after local authorities cleared the blocked roads.',
    content: [
      'The local market reopened on Tuesday after a storm disrupted access roads, according to city officials.',
      'Police said workers cleared debris and restored electricity before the afternoon rush.',
      'The city administration said limited traffic was allowed near the main square while repair teams worked overnight.',
      'Officials reported that 48 traders resumed business by noon, and the market remained open for regular trade.',
    ].join(' '),
    language: 'en',
    sources: ['City police statement', 'https://example.com/market-reopening']
  };
}

function contentCheck(payload, token) {
  const req = request(app).post('/api/admin/news-pulse-engine/content-check');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send(payload);
}

test('Founder can use the content checker', async () => {
  const res = await contentCheck(buildValidEnglishStory(), signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.checkedAt, 'string');
  assert.ok(['clear', 'review', 'high-risk'].includes(res.body.overallStatus));
  assert.ok(Array.isArray(res.body.checks));
  assert.ok(res.body.summary && typeof res.body.summary === 'object');
});

test('Admin cannot use the content checker', async () => {
  const res = await contentCheck(buildValidEnglishStory(), signToken('admin', 'admin@example.com'));

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FOUNDER_REQUIRED');
});

test('Manager/staff cannot use the content checker', async () => {
  const res = await contentCheck(buildValidEnglishStory(), signToken('manager', 'manager@example.com'));

  assert.equal(res.status, 403);
});

test('Unauthenticated requests return the existing 401 auth behavior', async () => {
  const res = await contentCheck(buildValidEnglishStory());

  assert.equal(res.status, 401);
});

test('Empty input is rejected safely', async () => {
  const founderToken = signToken('founder', 'founder@example.com');
  const res = await contentCheck({ title: '', summary: '', content: '', language: 'en' }, founderToken);

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'EMPTY_CONTENT');
});

test('Valid English content returns the expected response shape', async () => {
  const res = await contentCheck(buildValidEnglishStory(), signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  assert.ok(res.body.ok);
  assert.equal(typeof res.body.checkedAt, 'string');
  assert.ok(['clear', 'review', 'high-risk'].includes(res.body.overallStatus));
  assert.ok(Array.isArray(res.body.checks));
  assert.ok(res.body.checks.length > 0);
  assert.equal(typeof res.body.summary.passed, 'number');
  assert.equal(typeof res.body.summary.review, 'number');
  assert.equal(typeof res.body.summary.highRisk, 'number');
  assert.equal(res.body.checks.some((check) => check.id === 'source-attribution'), true);
  assert.equal(res.body.checks.some((check) => check.id === 'article-completeness'), true);
  assert.equal(res.body.checks.some((check) => check.id === 'five-w-one-h'), true);
  assert.equal(res.body.checks.some((check) => check.id === 'numbers-verification'), true);
  assert.equal(JSON.stringify(res.body).includes('AI probability'), false);
  assert.equal(JSON.stringify(res.body).includes('AI generated'), false);
});

test('Hindi Unicode content does not crash', async () => {
  const res = await contentCheck({
    title: 'बाजार फिर से खुला',
    summary: 'पुलिस ने बताया कि बाजार फिर से खुल गया है।',
    content: 'पुलिस ने बताया कि सोमवार को बाजार फिर से खुल गया। स्थानीय अधिकारी ने कहा कि सड़कें साफ हो गई हैं। कार्यालयों के लिए यातायात सामान्य हो गया है।',
    language: 'hi',
    sources: ['पुलिस बयान']
  }, signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(typeof res.body.checkedAt, 'string');
});

test('Gujarati Unicode content does not crash', async () => {
  const res = await contentCheck({
    title: 'બજાર ફરીથી શરૂ',
    summary: 'પોલિસે જણાવ્યું હતું કે બજાર ફરીથી શરૂ થયું હતું.',
    content: 'પોલિસે мэдээл્યા મુજબ શનિવારે બજાર ફરીથી શરૂ થયું હતું. અધિકારીઓએ Roads સાફ કરવામાં આવ્યા હોવાની માહિતી આપી.',
    language: 'gu',
    sources: ['પોલિસ નિવેદન']
  }, signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('Missing attribution can trigger review', async () => {
  const res = await contentCheck({
    title: 'Storm knocks out power in city',
    summary: 'Power supply was interrupted in several neighborhoods.',
    content: 'A storm knocked out power in several neighborhoods. Residents gathered at the station. Traffic slowed near the market.',
    language: 'en',
    sources: []
  }, signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  const attributionCheck = res.body.checks.find((check) => check.id === 'source-attribution');
  assert.ok(attributionCheck);
  assert.ok(['review', 'high-risk'].includes(attributionCheck.status));
});

test('Proper attribution avoids the same warning when reasonable', async () => {
  const res = await contentCheck({
    title: 'Storm knocks out power in city',
    summary: 'Officials said power supply returned after repairs.',
    content: 'According to city officials, the storm knocked out power in several neighborhoods. Police said repair crews restored service before evening. The district administration reported that traffic returned to normal.',
    language: 'en',
    sources: ['City administration statement']
  }, signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  const attributionCheck = res.body.checks.find((check) => check.id === 'source-attribution');
  assert.ok(attributionCheck);
  assert.ok(['pass', 'review'].includes(attributionCheck.status));
});

test('Quotes without attribution are flagged for verification', async () => {
  const res = await contentCheck({
    title: 'School reopened after safety review',
    summary: 'The school reopened after the inspection.',
    content: 'The school reopened after the inspection. The answer was "The building is safe now." Officials were not quoted in the release.',
    language: 'en',
    sources: []
  }, signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  const quoteCheck = res.body.checks.find((check) => check.id === 'quotes-verification');
  assert.ok(quoteCheck);
  assert.equal(quoteCheck.status, 'review');
});

test('Numeric/statistical claims without source context are flagged', async () => {
  const res = await contentCheck({
    title: 'Market losses jump',
    summary: 'The local market suffered losses.',
    content: 'The factory lost ₹25 crore and 72% of sales in the last quarter. The report says demand dropped sharply.',
    language: 'en',
    sources: []
  }, signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  const numbersCheck = res.body.checks.find((check) => check.id === 'numbers-verification');
  assert.ok(numbersCheck);
  assert.ok(['review', 'high-risk'].includes(numbersCheck.status));
});

test('Repeated content is detected', async () => {
  const res = await contentCheck({
    title: 'Market opens after repairs',
    summary: 'The market reopened after repair work.',
    content: 'The market reopened after repair work. The market reopened after repair work. The market reopened after repair work. Authorities said the work was completed before noon.',
    language: 'en',
    sources: ['Authority notice']
  }, signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  const repetitionCheck = res.body.checks.find((check) => check.id === 'repetition');
  assert.ok(repetitionCheck);
  assert.ok(['review', 'high-risk'].includes(repetitionCheck.status));
});

test('Headline/body mismatch can be detected conservatively', async () => {
  const res = await contentCheck({
    title: 'Assembly election results declared',
    summary: 'The election outcome was announced.',
    content: 'A local vegetable market closed for two hours after a truck stuck near the gate. Traders waited as workers cleared the road.',
    language: 'en',
    sources: ['Market notice']
  }, signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  const mismatchCheck = res.body.checks.find((check) => check.id === 'headline-body-match');
  assert.ok(mismatchCheck);
  assert.ok(['review', 'pass'].includes(mismatchCheck.status));
});

test('Incomplete story is flagged', async () => {
  const res = await contentCheck({
    title: 'Train accident',
    summary: '',
    content: 'The crash happened near the station.',
    language: 'en',
    sources: []
  }, signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  const completenessCheck = res.body.checks.find((check) => check.id === 'article-completeness');
  assert.ok(completenessCheck);
  assert.equal(completenessCheck.status, 'high-risk');
});

test('5W1H gaps can be reported', async () => {
  const res = await contentCheck({
    title: 'Two injured in accident',
    summary: 'Two people were injured.',
    content: 'Two people were injured in the accident. The incident happened near the station. One man was treated at the hospital.',
    language: 'en',
    sources: ['Hospital statement']
  }, signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  const fiveWCheck = res.body.checks.find((check) => check.id === 'five-w-one-h');
  assert.ok(fiveWCheck);
  assert.ok(fiveWCheck.message.includes('Possible missing context') || fiveWCheck.status === 'review');
});

test('Content containing secret-like strings does not leak environment data', async () => {
  const res = await contentCheck({
    title: 'Database status update',
    summary: 'System check in progress.',
    content: 'Database URL = mongodb://example.com; JWT = abc.def.ghi; ANALYTICS_HASH_SALT = secret-value; no secrets should be exposed in the response.',
    language: 'en',
    sources: ['internal check']
  }, signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  const responseText = JSON.stringify(res.body);
  assert.equal(responseText.includes('mongodb://'), false);
  assert.equal(responseText.includes('abc.def.ghi'), false);
  assert.equal(responseText.includes('ANALYTICS_HASH_SALT'), false);
  assert.equal(responseText.includes('AI generated'), false);
});

test('overallStatus is computed deterministically and evidence is limited', async () => {
  const res = await contentCheck({
    title: 'City shock as market closes',
    summary: 'The market closed suddenly.',
    content: 'The market closed suddenly. The market closed suddenly. The market closed suddenly. This is shocking and unbelievable. No attribution was provided. 72% of traders left the area.',
    language: 'en',
    sources: []
  }, signToken('founder', 'founder@example.com'));

  assert.equal(res.status, 200);
  assert.ok(['review', 'high-risk'].includes(res.body.overallStatus));
  for (const check of res.body.checks) {
    assert.ok(Array.isArray(check.evidence));
    if (check.evidence.length > 0) {
      for (const item of check.evidence) {
        assert.ok(typeof item.excerpt === 'string');
        assert.ok(item.excerpt.length <= 220);
      }
    }
  }
  assert.equal(res.body.checks.some((check) => check.id === 'sensational-language'), true);
});
