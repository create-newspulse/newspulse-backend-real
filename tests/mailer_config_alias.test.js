const test = require('node:test');
const assert = require('node:assert');

const trackedKeys = [
  'EMAIL_MODE',
  'NODE_ENV',
  'RENDER_SERVICE_ID',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
  'SMTP_FROM',
  'EMAIL_FROM',
  'FROM_EMAIL',
  'ADS_SMTP_HOST',
  'ADS_SMTP_PORT',
  'ADS_SMTP_USER',
  'ADS_SMTP_PASS',
  'ADS_SMTP_FROM',
];

function loadMailer() {
  const modulePath = require.resolve('../lib/mailer');
  delete require.cache[modulePath];
  return require('../lib/mailer');
}

test('getMailerStatus treats FROM_EMAIL as a valid sender alias', () => {
  const previousEnv = {};
  for (const key of trackedKeys) previousEnv[key] = process.env[key];

  try {
    delete process.env.EMAIL_MODE;
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'reporter@example.com';
    process.env.SMTP_PASS = 'app-password';
    delete process.env.SMTP_FROM;
    delete process.env.EMAIL_FROM;
    process.env.FROM_EMAIL = 'NewsPulse Reporter <reporter@example.com>';
    delete process.env.ADS_SMTP_HOST;
    delete process.env.ADS_SMTP_PORT;
    delete process.env.ADS_SMTP_USER;
    delete process.env.ADS_SMTP_PASS;
    delete process.env.ADS_SMTP_FROM;

    const { getMailerStatus } = loadMailer();
    const status = getMailerStatus();

    assert.strictEqual(status.configured, true);
    assert.deepStrictEqual(status.missing, []);
    assert.strictEqual(status.resolved.from, true);
  } finally {
    for (const key of trackedKeys) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
    loadMailer();
  }
});

test('getMailerStatus treats MAIL_FROM as a valid sender alias', () => {
  const previousEnv = {};
  for (const key of trackedKeys) previousEnv[key] = process.env[key];

  try {
    delete process.env.EMAIL_MODE;
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'reporter@example.com';
    process.env.SMTP_PASS = 'app-password';
    process.env.MAIL_FROM = 'NewsPulse Reporter <reporter@example.com>';
    delete process.env.SMTP_FROM;
    delete process.env.EMAIL_FROM;
    delete process.env.FROM_EMAIL;

    const { getMailerStatus } = loadMailer();
    const status = getMailerStatus();

    assert.strictEqual(status.configured, true);
    assert.deepStrictEqual(status.missing, []);
    assert.strictEqual(status.resolved.from, true);
  } finally {
    for (const key of trackedKeys) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
    loadMailer();
  }
});

test('getTransporter rejects stub mode in production-like environments', () => {
  const previousEnv = {};
  for (const key of trackedKeys) previousEnv[key] = process.env[key];

  try {
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_MODE = 'stub';
    process.env.RENDER_SERVICE_ID = 'svc-123';

    const { getTransporter } = loadMailer();
    assert.throws(() => getTransporter(), /production/i);
  } finally {
    for (const key of trackedKeys) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
    loadMailer();
  }
});