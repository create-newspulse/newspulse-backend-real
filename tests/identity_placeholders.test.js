const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEmailForIdentity,
  normalizePhoneForIdentity,
  normalizePersonNameKey,
  isPlaceholderEmail,
} = require('../lib/identity');

test('normalizeEmailForIdentity strips placeholder/example and noreply emails', () => {
  assert.equal(normalizeEmailForIdentity('reporter@example.com'), null);
  assert.equal(normalizeEmailForIdentity('USER@EXAMPLE.COM'), null);
  assert.equal(normalizeEmailForIdentity('no-reply@newspulse.ai'), null);

  assert.equal(normalizeEmailForIdentity('real.user@gmail.com'), 'real.user@gmail.com');
});

test('isPlaceholderEmail detects example domains', () => {
  assert.equal(isPlaceholderEmail('reporter@example.com'), true);
  // We only treat well-known dummy locals on example.* as placeholder.
  assert.equal(isPlaceholderEmail('x@example.org'), false);
  assert.equal(isPlaceholderEmail('person@domain.com'), false);
});

test('normalizePhoneForIdentity rejects obvious dummy numbers', () => {
  assert.equal(normalizePhoneForIdentity('0000000000'), null);
  assert.equal(normalizePhoneForIdentity('+91 1234567890'), null);

  assert.equal(normalizePhoneForIdentity('+91 98765 43210'), '+919876543210');
  assert.equal(normalizePhoneForIdentity('9876543210'), '9876543210');
});

test('normalizePersonNameKey normalizes and rejects unknown', () => {
  assert.equal(normalizePersonNameKey('  John   Doe '), 'john doe');
  assert.equal(normalizePersonNameKey('Unknown reporter'), null);
  assert.equal(normalizePersonNameKey('unknown'), null);
});
