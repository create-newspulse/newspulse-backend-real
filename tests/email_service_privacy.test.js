const test = require('node:test');
const assert = require('node:assert/strict');

const nodemailer = require('nodemailer');

function loadEmailServiceFresh() {
  const modulePath = require.resolve('../lib/emailService');
  delete require.cache[modulePath];
  return require('../lib/emailService');
}

function withEnv(updates, fn) {
  const original = new Map();
  for (const key of Object.keys(updates)) {
    original.set(key, process.env[key]);
    const nextValue = updates[key];
    if (nextValue === undefined) delete process.env[key];
    else process.env[key] = nextValue;
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of original.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test('privacy email config prefers privacy-scoped SMTP values and from address', async () => {
  await withEnv({
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'default@example.com',
    SMTP_PASS: 'default-pass',
    SMTP_FROM: 'Default Sender <default@example.com>',
    SMTP_USER_PRIVACY: 'privacy@example.com',
    SMTP_PASS_PRIVACY: 'privacy-pass',
    SMTP_FROM_PRIVACY: 'News Pulse Privacy <privacy@example.com>',
  }, async () => {
    const emailService = loadEmailServiceFresh();
    const config = emailService.getPrivacyEmailConfig();
    assert.equal(config.smtpUser, 'privacy@example.com');
    assert.equal(config.smtpPass, 'privacy-pass');
    assert.equal(config.fromAddress, 'News Pulse Privacy <privacy@example.com>');
    emailService.resetTransporters();
  });
});

test('privacy transporter falls back to default SMTP credentials when privacy credentials are missing', async () => {
  await withEnv({
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'default@example.com',
    SMTP_PASS: 'default-pass',
    SMTP_FROM: 'Default Sender <default@example.com>',
    SMTP_USER_PRIVACY: undefined,
    SMTP_PASS_PRIVACY: undefined,
    SMTP_FROM_PRIVACY: undefined,
  }, async () => {
    const created = [];
    const originalCreateTransport = nodemailer.createTransport;
    nodemailer.createTransport = (config) => {
      created.push(config);
      return { sendMail: async () => ({ accepted: ['ok@example.com'] }) };
    };

    try {
      const emailService = loadEmailServiceFresh();
      const transport = emailService.getPrivacyTransporter();
      assert.ok(transport);
      assert.equal(created.length, 1);
      assert.equal(created[0].auth.user, 'default@example.com');
      assert.equal(created[0].auth.pass, 'default-pass');
      assert.equal(emailService.getPrivacyEmailConfig().fromAddress, 'Default Sender <default@example.com>');
      emailService.resetTransporters();
    } finally {
      nodemailer.createTransport = originalCreateTransport;
    }
  });
});