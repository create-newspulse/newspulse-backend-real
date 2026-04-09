const test = require('node:test');
const assert = require('node:assert');

const trackedKeys = [
  'EMAIL_MODE',
  'EMAIL_PROVIDER',
  'MAIL_PROVIDER',
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
  'RESEND_API_KEY',
  'RESEND_FROM',
  'RESEND_REPLY_TO',
];

function loadMailer() {
  const modulePath = require.resolve('../lib/mailer');
  delete require.cache[modulePath];
  return require('../lib/mailer');
}

async function withMockedNodemailer(createTransport, run) {
  const nodemailerPath = require.resolve('nodemailer');
  const originalEntry = require.cache[nodemailerPath];
  require.cache[nodemailerPath] = {
    id: nodemailerPath,
    filename: nodemailerPath,
    loaded: true,
    exports: { createTransport },
  };

  try {
    return await run();
  } finally {
    const mailerPath = require.resolve('../lib/mailer');
    delete require.cache[mailerPath];
    if (originalEntry) {
      require.cache[nodemailerPath] = originalEntry;
    } else {
      delete require.cache[nodemailerPath];
    }
  }
}

async function withMockedAxios(exportsValue, run) {
  const axiosPath = require.resolve('axios');
  const originalEntry = require.cache[axiosPath];
  require.cache[axiosPath] = {
    id: axiosPath,
    filename: axiosPath,
    loaded: true,
    exports: exportsValue,
  };

  try {
    return await run();
  } finally {
    const mailerPath = require.resolve('../lib/mailer');
    delete require.cache[mailerPath];
    if (originalEntry) {
      require.cache[axiosPath] = originalEntry;
    } else {
      delete require.cache[axiosPath];
    }
  }
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

test('sendMail uses SMTP_FROM as envelope override, not visible From header', async () => {
  const previousEnv = {};
  for (const key of trackedKeys) previousEnv[key] = process.env[key];

  try {
    delete process.env.EMAIL_MODE;
    delete process.env.MAIL_FROM;
    delete process.env.FROM_EMAIL;
    delete process.env.EMAIL_FROM;
    delete process.env.ADS_SMTP_FROM;
    delete process.env.ADS_SMTP_HOST;
    delete process.env.ADS_SMTP_PORT;
    delete process.env.ADS_SMTP_USER;
    delete process.env.ADS_SMTP_PASS;

    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'reporter@example.com';
    process.env.SMTP_PASS = 'app-password';
    process.env.SMTP_FROM = 'noreply@newspulse.co.in';

    let capturedOptions = null;
    await withMockedNodemailer(
      () => ({
        verify: () => Promise.resolve(),
        sendMail: async (options) => {
          capturedOptions = options;
          return {
            messageId: 'mock-message-id',
            accepted: [String(options.to || '').toLowerCase()],
            rejected: [],
            response: '250 queued',
            envelope: options.envelope || null,
          };
        },
      }),
      async () => {
        const { sendMail, getMailerStatus } = loadMailer();
        const status = getMailerStatus();

        assert.strictEqual(status.configured, true);
        assert.strictEqual(status.resolved.from, true);
        assert.strictEqual(status.resolved.envelopeFrom, true);

        await sendMail({
          to: 'recipient@example.com',
          subject: 'Reporter OTP',
          text: 'Test message',
        });
      }
    );

    assert.ok(capturedOptions);
    assert.strictEqual(capturedOptions.from, 'reporter@example.com');
    assert.deepStrictEqual(capturedOptions.envelope, { from: 'noreply@newspulse.co.in' });
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

test('getMailerStatus resolves Resend provider when SMTP is absent and RESEND env is configured', () => {
  const previousEnv = {};
  for (const key of trackedKeys) previousEnv[key] = process.env[key];

  try {
    delete process.env.EMAIL_MODE;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.MAIL_PROVIDER;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.MAIL_FROM;
    delete process.env.FROM_EMAIL;
    delete process.env.EMAIL_FROM;
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM = 'NewsPulse Reporter <reporter@newspulse.co.in>';

    const { getMailerStatus } = loadMailer();
    const status = getMailerStatus();

    assert.strictEqual(status.provider, 'resend');
    assert.strictEqual(status.configured, true);
    assert.deepStrictEqual(status.missing, []);
    assert.strictEqual(status.resolved.resendApiKey, true);
    assert.strictEqual(status.resolved.resendFrom, true);
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

test('sendMail uses Resend when configured as the active provider', async () => {
  const previousEnv = {};
  for (const key of trackedKeys) previousEnv[key] = process.env[key];

  try {
    delete process.env.EMAIL_MODE;
    process.env.EMAIL_PROVIDER = 'resend';
    delete process.env.MAIL_PROVIDER;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.MAIL_FROM;
    delete process.env.FROM_EMAIL;
    delete process.env.EMAIL_FROM;
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM = 'NewsPulse Reporter <reporter@newspulse.co.in>';
    process.env.RESEND_REPLY_TO = 'support@newspulse.co.in';

    let capturedRequest = null;
    await withMockedAxios(
      {
        post: async (url, payload, options) => {
          capturedRequest = { url, payload, options };
          return {
            status: 200,
            statusText: 'OK',
            data: { id: 're_mock_id' },
          };
        },
      },
      async () => {
        const { getMailerStatus, getTransporter, sendMail } = loadMailer();
        const status = getMailerStatus();

        assert.strictEqual(status.provider, 'resend');
        assert.strictEqual(status.configured, true);

        const transporter = getTransporter();
        assert.ok(transporter);
        assert.strictEqual(transporter.provider, 'resend');

        const info = await sendMail({
          to: 'recipient@example.com',
          subject: 'Reporter OTP',
          text: 'Test message',
        });

        assert.strictEqual(info.provider, 'resend');
        assert.deepStrictEqual(info.accepted, ['recipient@example.com']);
        assert.strictEqual(info.messageId, 're_mock_id');
      }
    );

    assert.ok(capturedRequest);
    assert.strictEqual(capturedRequest.url, 'https://api.resend.com/emails');
    assert.strictEqual(capturedRequest.payload.from, 'NewsPulse Reporter <reporter@newspulse.co.in>');
    assert.deepStrictEqual(capturedRequest.payload.to, ['recipient@example.com']);
    assert.strictEqual(capturedRequest.payload.reply_to, 'support@newspulse.co.in');
    assert.strictEqual(capturedRequest.options.headers.Authorization, 'Bearer re_test_key');
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

test('sendMail maps Resend timeouts to PROVIDER_TIMEOUT', async () => {
  const previousEnv = {};
  for (const key of trackedKeys) previousEnv[key] = process.env[key];

  try {
    delete process.env.EMAIL_MODE;
    process.env.EMAIL_PROVIDER = 'resend';
    delete process.env.MAIL_PROVIDER;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.MAIL_FROM;
    delete process.env.FROM_EMAIL;
    delete process.env.EMAIL_FROM;
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM = 'NewsPulse Reporter <reporter@newspulse.co.in>';

    await withMockedAxios(
      {
        post: async () => {
          const error = new Error('timeout of 10000ms exceeded');
          error.code = 'ECONNABORTED';
          throw error;
        },
      },
      async () => {
        const { sendMail } = loadMailer();
        await assert.rejects(
          () => sendMail({ to: 'recipient@example.com', subject: 'Reporter OTP', text: 'Test message' }),
          (error) => error && error.backendCode === 'PROVIDER_TIMEOUT'
        );
      }
    );
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

test('getMailerStatus prefers Resend first in production when both Resend and SMTP are configured', () => {
  const previousEnv = {};
  for (const key of trackedKeys) previousEnv[key] = process.env[key];

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.EMAIL_MODE;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.MAIL_PROVIDER;
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'reporter@example.com';
    process.env.SMTP_PASS = 'app-password';
    process.env.FROM_EMAIL = 'NewsPulse Reporter <reporter@example.com>';
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM = 'NewsPulse Reporter <reporter@newspulse.co.in>';

    const { getMailerStatus } = loadMailer();
    const status = getMailerStatus();

    assert.strictEqual(status.provider, 'resend');
    assert.deepStrictEqual(status.providerOrder, ['resend', 'smtp']);
    assert.strictEqual(status.fallbackProvider, 'smtp');
    assert.strictEqual(status.resolved.secure, false);
    assert.strictEqual(status.resolved.portNumber, 587);
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

test('sendMail falls back to SMTP in production when Resend is primary and times out', async () => {
  const previousEnv = {};
  for (const key of trackedKeys) previousEnv[key] = process.env[key];

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.EMAIL_MODE;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.MAIL_PROVIDER;
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'reporter@example.com';
    process.env.SMTP_PASS = 'app-password';
    process.env.SMTP_FROM = 'noreply@newspulse.co.in';
    process.env.FROM_EMAIL = 'NewsPulse Reporter <reporter@example.com>';
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM = 'NewsPulse Reporter <reporter@newspulse.co.in>';

    let smtpSendCount = 0;
    await withMockedAxios(
      {
        post: async () => {
          const error = new Error('timeout of 10000ms exceeded');
          error.code = 'ECONNABORTED';
          throw error;
        },
      },
      async () => {
        await withMockedNodemailer(
          () => ({
            verify: () => Promise.resolve(),
            sendMail: async (options) => {
              smtpSendCount += 1;
              return {
                provider: 'smtp',
                messageId: 'smtp-fallback-id',
                accepted: [String(options.to || '').toLowerCase()],
                rejected: [],
                response: '250 queued',
                envelope: options.envelope || null,
              };
            },
          }),
          async () => {
            const { sendMail } = loadMailer();
            const info = await sendMail({
              to: 'recipient@example.com',
              subject: 'Reporter OTP',
              text: 'Fallback test',
            });

            assert.strictEqual(info.provider, 'smtp');
            assert.strictEqual(info.messageId, 'smtp-fallback-id');
          }
        );
      }
    );

    assert.strictEqual(smtpSendCount, 1);
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

test('getMailerStatus forces secure mode on SMTP port 465 even if SMTP_SECURE is false', () => {
  const previousEnv = {};
  for (const key of trackedKeys) previousEnv[key] = process.env[key];

  try {
    delete process.env.EMAIL_MODE;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.MAIL_PROVIDER;
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = 'false';
    process.env.SMTP_USER = 'reporter@example.com';
    process.env.SMTP_PASS = 'app-password';
    process.env.FROM_EMAIL = 'NewsPulse Reporter <reporter@example.com>';

    const { getMailerStatus } = loadMailer();
    const status = getMailerStatus();

    assert.strictEqual(status.resolved.portNumber, 465);
    assert.strictEqual(status.resolved.secure, true);
    assert.strictEqual(status.resolved.secureAdjusted, true);
    assert.strictEqual(status.resolved.secureSource, 'port-465');
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

test('getMailerStatus forces non-secure start on SMTP port 587 even if SMTP_SECURE is true', () => {
  const previousEnv = {};
  for (const key of trackedKeys) previousEnv[key] = process.env[key];

  try {
    delete process.env.EMAIL_MODE;
    delete process.env.EMAIL_PROVIDER;
    delete process.env.MAIL_PROVIDER;
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_SECURE = 'true';
    process.env.SMTP_USER = 'reporter@example.com';
    process.env.SMTP_PASS = 'app-password';
    process.env.FROM_EMAIL = 'NewsPulse Reporter <reporter@example.com>';

    const { getMailerStatus } = loadMailer();
    const status = getMailerStatus();

    assert.strictEqual(status.resolved.portNumber, 587);
    assert.strictEqual(status.resolved.secure, false);
    assert.strictEqual(status.resolved.secureAdjusted, true);
    assert.strictEqual(status.resolved.secureSource, 'port-587');
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