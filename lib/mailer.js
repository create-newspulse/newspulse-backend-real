const axios = require('axios');
const nodemailer = require('nodemailer');

const RESEND_API_URL = 'https://api.resend.com/emails';
const transporters = new Map();
const transporterHealth = new Map();

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isRenderLike() {
  return !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
}

function isProductionLike() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production' || isRenderLike();
}

function parseBool(value, fallback = false) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return !!fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return !!fallback;
}

function normalizeProviderName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['stub', 'smtp', 'resend'].includes(normalized)) return normalized;
  return '';
}

function normalizeRecipients(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  const single = String(value || '').trim();
  return single ? [single] : [];
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function serializeMailError(error) {
  return {
    message: error?.message || String(error),
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.backendCode ? { backendCode: error.backendCode } : {}),
    ...(error?.provider ? { provider: error.provider } : {}),
    ...(error?.status ? { status: error.status } : {}),
    ...(error?.responseCode ? { responseCode: error.responseCode } : {}),
    ...(error?.command ? { command: error.command } : {}),
    ...(error?.errno ? { errno: error.errno } : {}),
    ...(error?.syscall ? { syscall: error.syscall } : {}),
  };
}

function buildSmtpMissing(config) {
  const missing = [];
  if (!config.smtpHost && !config.smtpService) missing.push('SMTP_HOST|SMTP_SERVICE');
  if (!config.smtpPort && !config.smtpService) missing.push('SMTP_PORT');
  if (!config.smtpUser) missing.push('SMTP_USER');
  if (!config.smtpPass) missing.push('SMTP_PASS');
  if (!config.smtpFrom) missing.push('MAIL_FROM|FROM_EMAIL|EMAIL_FROM|ADS_SMTP_FROM|SMTP_USER');
  return missing;
}

function buildResendMissing(config) {
  const missing = [];
  if (!config.resendApiKey) missing.push('RESEND_API_KEY');
  if (!config.resendFrom) missing.push('RESEND_FROM|MAIL_FROM|FROM_EMAIL|EMAIL_FROM');
  return missing;
}

function resolveProviderSelection(config) {
  const preferredProvider = normalizeProviderName(config.preferredProvider);
  const smtpConfigured = config.smtpMissing.length === 0;
  const resendConfigured = config.resendMissing.length === 0;
  const resendHintPresent = !!(config.resendApiKey || config.resendFrom);
  const smtpHintPresent = !!(config.smtpHost || config.smtpService || config.smtpUser || config.smtpPass || config.smtpFrom);
  const order = [];

  const pushProvider = (provider, configured) => {
    if (!provider || !configured || order.includes(provider)) return;
    order.push(provider);
  };

  if (config.emailMode === 'stub') {
    return { provider: 'stub', configured: true, missing: [], order: ['stub'] };
  }
  if (preferredProvider === 'smtp') {
    pushProvider('smtp', smtpConfigured);
    pushProvider('resend', resendConfigured);
    return { provider: 'smtp', configured: smtpConfigured, missing: [...config.smtpMissing], order: order.length ? order : ['smtp'] };
  }
  if (preferredProvider === 'resend') {
    pushProvider('resend', resendConfigured);
    pushProvider('smtp', smtpConfigured);
    return { provider: 'resend', configured: resendConfigured, missing: [...config.resendMissing], order: order.length ? order : ['resend'] };
  }
  if (isProductionLike() && resendConfigured) {
    pushProvider('resend', true);
    pushProvider('smtp', smtpConfigured);
    return { provider: 'resend', configured: true, missing: [], order };
  }
  if (smtpConfigured) {
    pushProvider('smtp', true);
    pushProvider('resend', resendConfigured && isProductionLike());
    return { provider: 'smtp', configured: true, missing: [], order };
  }
  if (resendConfigured) {
    pushProvider('resend', true);
    pushProvider('smtp', smtpConfigured);
    return { provider: 'resend', configured: true, missing: [], order };
  }
  if (resendHintPresent && !smtpHintPresent) {
    return { provider: 'resend', configured: false, missing: [...config.resendMissing], order: ['resend'] };
  }
  if (smtpHintPresent || config.smtpMissing.length) {
    return { provider: 'smtp', configured: false, missing: [...config.smtpMissing], order: ['smtp'] };
  }
  return {
    provider: resendHintPresent ? 'resend' : 'smtp',
    configured: false,
    missing: resendHintPresent ? [...config.resendMissing] : [...config.smtpMissing],
    order: [resendHintPresent ? 'resend' : 'smtp'],
  };
}

function getMailConfig() {
  const emailMode = firstNonEmpty(process.env.EMAIL_MODE).toLowerCase();
  const preferredProvider = firstNonEmpty(process.env.EMAIL_PROVIDER, process.env.MAIL_PROVIDER);
  const smtpService = firstNonEmpty(process.env.SMTP_SERVICE, process.env.ADS_SMTP_SERVICE);
  const smtpHost = firstNonEmpty(process.env.SMTP_HOST, process.env.ADS_SMTP_HOST);
  const smtpPort = firstNonEmpty(process.env.SMTP_PORT, process.env.ADS_SMTP_PORT);
  const smtpUser = firstNonEmpty(process.env.SMTP_USER, process.env.ADS_SMTP_USER);
  const smtpPass = firstNonEmpty(process.env.SMTP_PASS, process.env.ADS_SMTP_PASS);
  const smtpFrom = firstNonEmpty(process.env.MAIL_FROM, process.env.FROM_EMAIL, process.env.EMAIL_FROM, process.env.ADS_SMTP_FROM, smtpUser);
  const smtpEnvelopeFrom = firstNonEmpty(process.env.SMTP_FROM);
  const smtpSecure = firstNonEmpty(process.env.SMTP_SECURE, process.env.ADS_SMTP_SECURE);
  const smtpPool = firstNonEmpty(process.env.SMTP_POOL, process.env.ADS_SMTP_POOL);
  const smtpMaxConn = firstNonEmpty(process.env.SMTP_MAX_CONN, process.env.ADS_SMTP_MAX_CONN);
  const smtpDebug = firstNonEmpty(process.env.SMTP_DEBUG, process.env.ADS_SMTP_DEBUG);
  const resendApiKey = firstNonEmpty(process.env.RESEND_API_KEY);
  const resendFrom = firstNonEmpty(process.env.RESEND_FROM, process.env.MAIL_FROM, process.env.FROM_EMAIL, process.env.EMAIL_FROM);
  const resendReplyTo = firstNonEmpty(process.env.RESEND_REPLY_TO);
  const appBaseUrl = firstNonEmpty(process.env.APP_BASE_URL, process.env.SITE_URL, process.env.PUBLIC_BASE_URL, process.env.RENDER_EXTERNAL_URL);
  const providerTimeoutMs = toPositiveNumber(process.env.EMAIL_PROVIDER_TIMEOUT_MS, 10000);
  const smtpPortNumber = smtpPort ? Number(smtpPort) : (smtpService ? null : 587);
  const smtpSecureResolved = parseBool(smtpSecure, smtpPortNumber === 465);

  const config = {
    emailMode,
    preferredProvider,
    smtpService,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    smtpFrom,
    smtpEnvelopeFrom,
    smtpSecure,
    smtpPool,
    smtpMaxConn,
    smtpDebug,
    resendApiKey,
    resendFrom,
    resendReplyTo,
    appBaseUrl,
    providerTimeoutMs,
    smtpPortNumber,
    smtpSecureResolved,
  };

  config.smtpMissing = buildSmtpMissing(config);
  config.resendMissing = buildResendMissing(config);
  const activeProvider = resolveProviderSelection(config);
  config.provider = activeProvider.provider;
  config.providerOrder = activeProvider.order;
  config.fallbackProvider = activeProvider.order.find((provider) => provider !== config.provider) || null;
  config.missing = activeProvider.missing;
  config.configured = activeProvider.configured;

  return config;
}

function getTransportHealth(provider) {
  return transporterHealth.get(provider) || null;
}

function setTransportHealth(provider, next) {
  const previous = transporterHealth.get(provider) || {};
  transporterHealth.set(provider, {
    ...previous,
    ...next,
    provider,
    updatedAt: new Date().toISOString(),
  });
}

function getTransportHealthSnapshot(config) {
  const providers = Array.from(new Set([config.provider, ...(Array.isArray(config.providerOrder) ? config.providerOrder : [])].filter(Boolean)));
  const snapshot = {};
  for (const provider of providers) {
    snapshot[provider] = getTransportHealth(provider);
  }
  return snapshot;
}

function getMailerStatus() {
  const config = getMailConfig();
  return {
    productionLike: isProductionLike(),
    renderLike: isRenderLike(),
    stubMode: config.emailMode === 'stub',
    provider: config.provider,
    providerOrder: [...config.providerOrder],
    fallbackProvider: config.fallbackProvider,
    configured: config.configured,
    missing: [...config.missing],
    resolved: {
      host: !!config.smtpHost,
      service: !!config.smtpService,
      port: !!config.smtpPort,
      portNumber: config.smtpPortNumber,
      secure: config.smtpSecureResolved,
      user: !!config.smtpUser,
      pass: !!config.smtpPass,
      from: !!config.smtpFrom,
      envelopeFrom: !!config.smtpEnvelopeFrom,
      resendApiKey: !!config.resendApiKey,
      resendFrom: !!config.resendFrom,
      resendReplyTo: !!config.resendReplyTo,
      appBaseUrl: !!config.appBaseUrl,
      timeoutMs: config.providerTimeoutMs,
    },
    transport: getTransportHealthSnapshot(config),
  };
}

function buildMailerConfigError(message, options = {}) {
  const error = new Error(message);
  error.code = options.code || 'MAILER_NOT_CONFIGURED';
  error.backendCode = options.backendCode || 'MAILER_NOT_CONFIGURED';
  error.provider = options.provider || null;
  if (options.missing) error.missing = [...options.missing];
  return error;
}

function buildSmtpTransport(config) {
  const providerTimeoutMs = config.providerTimeoutMs;
  const portNum = Number(config.smtpPortNumber || 587);
  const secure = config.smtpSecureResolved;
  const usePool = parseBool(config.smtpPool, false);
  const maxConnections = config.smtpMaxConn ? Number(config.smtpMaxConn) : undefined;

  const baseConfig = {
    secure,
    auth: { user: config.smtpUser, pass: config.smtpPass },
    connectionTimeout: providerTimeoutMs,
    greetingTimeout: providerTimeoutMs,
    socketTimeout: providerTimeoutMs,
  };
  if (config.smtpService) {
    baseConfig.service = config.smtpService;
  } else {
    baseConfig.host = config.smtpHost;
    baseConfig.port = portNum;
  }
  if (usePool) {
    baseConfig.pool = true;
    if (maxConnections) baseConfig.maxConnections = maxConnections;
  }
  if (parseBool(config.smtpDebug, false)) {
    baseConfig.logger = true;
    baseConfig.debug = true;
  }

  console.log('[EMAIL][transporter-init]', {
    provider: 'smtp',
    host: baseConfig.host || baseConfig.service || null,
    port: baseConfig.port || null,
    secure: baseConfig.secure,
    timeoutMs: providerTimeoutMs,
    pool: !!baseConfig.pool,
    fromConfigured: !!config.smtpFrom,
    envelopeFromConfigured: !!config.smtpEnvelopeFrom,
    appBaseUrlConfigured: !!config.appBaseUrl,
    productionLike: isProductionLike(),
  });

  setTransportHealth('smtp', {
    state: 'initializing',
    backendCode: null,
    error: null,
    metadata: {
      host: baseConfig.host || baseConfig.service || null,
      port: baseConfig.port || null,
      secure: baseConfig.secure,
      timeoutMs: providerTimeoutMs,
      pool: !!baseConfig.pool,
      fromConfigured: !!config.smtpFrom,
    },
  });

  const transport = nodemailer.createTransport(baseConfig);
  transport.provider = 'smtp';

  transport.verify().then(() => {
    console.log('[EMAIL][transporter-ready]', {
      provider: 'smtp',
      host: baseConfig.host || baseConfig.service || null,
      port: baseConfig.port || null,
      secure: baseConfig.secure,
      pool: !!baseConfig.pool,
      userConfigured: !!config.smtpUser,
    });
    setTransportHealth('smtp', {
      state: 'ready',
      backendCode: null,
      error: null,
    });
  }).catch((err) => {
    const classified = classifyAndWrapMailerError(err, { provider: 'smtp' });
    console.error('[EMAIL][verify-fail]', JSON.stringify(serializeMailError(classified)));
    setTransportHealth('smtp', {
      state: 'failed',
      backendCode: classified.backendCode || null,
      error: serializeMailError(classified),
    });
  });

  return transport;
}

function buildResendTransport(config) {
  console.log('[EMAIL][transporter-init]', {
    provider: 'resend',
    fromConfigured: !!config.resendFrom,
    replyToConfigured: !!config.resendReplyTo,
    timeoutMs: config.providerTimeoutMs,
    appBaseUrlConfigured: !!config.appBaseUrl,
    productionLike: isProductionLike(),
  });

  setTransportHealth('resend', {
    state: 'ready',
    backendCode: null,
    error: null,
    metadata: {
      fromConfigured: !!config.resendFrom,
      replyToConfigured: !!config.resendReplyTo,
      timeoutMs: config.providerTimeoutMs,
    },
  });

  return {
    provider: 'resend',
    verify: async () => ({ ok: true, provider: 'resend' }),
    sendMail: async (options = {}) => {
      const to = normalizeRecipients(options.to);
      const payload = {
        from: options.from || config.resendFrom,
        to,
        subject: options.subject,
        ...(options.text ? { text: options.text } : {}),
        ...(options.html ? { html: options.html } : {}),
        ...(options.replyTo || config.resendReplyTo ? { reply_to: options.replyTo || config.resendReplyTo } : {}),
      };

      try {
        const response = await axios.post(RESEND_API_URL, payload, {
          headers: {
            Authorization: `Bearer ${config.resendApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: config.providerTimeoutMs,
        });
        const responseData = response && response.data && typeof response.data === 'object' ? response.data : {};
        console.log('[EMAIL][transporter-ready]', {
          provider: 'resend',
          fromConfigured: !!config.resendFrom,
          replyToConfigured: !!config.resendReplyTo,
        });
        setTransportHealth('resend', {
          state: 'ready',
          backendCode: null,
          error: null,
        });
        return {
          provider: 'resend',
          messageId: responseData.id || null,
          accepted: to.map((entry) => entry.toLowerCase()),
          rejected: [],
          response: `${response.status} ${response.statusText || 'OK'}`.trim(),
          envelope: { from: payload.from, to },
          raw: responseData,
        };
      } catch (error) {
        const classified = classifyAndWrapMailerError(error, { provider: 'resend' });
        setTransportHealth('resend', {
          state: 'failed',
          backendCode: classified.backendCode || null,
          error: serializeMailError(classified),
        });
        throw classified;
      }
    },
  };
}

function buildTransport(provider, config = getMailConfig()) {

  if (config.emailMode === 'stub' && isProductionLike()) {
    console.error('[EMAIL][config-error] Stub email mode is not allowed in production-like environments');
    throw buildMailerConfigError('Email stub mode is not allowed in production', {
      code: 'EMAIL_STUB_FORBIDDEN',
      provider: 'stub',
    });
  }

  if (config.emailMode === 'stub') {
    return {
      provider: 'stub',
      verify: async () => ({ ok: true, provider: 'stub' }),
      sendMail: async () => {
        throw buildMailerConfigError('Stub provider does not support direct sendMail in lib/mailer', {
          code: 'EMAIL_STUB_ONLY',
          provider: 'stub',
        });
      },
    };
  }

  if (!config.configured) {
    console.error('[EMAIL][config-error] Missing required env vars:', config.missing.join(', '));
    throw buildMailerConfigError(`Email service not configured: ${config.missing.join(', ')}`, {
      provider: config.provider,
      missing: config.missing,
    });
  }

  if (provider === 'resend') {
    return buildResendTransport(config);
  }

  return buildSmtpTransport(config);
}

function classifyAndWrapMailerError(error, options = {}) {
  const provider = options.provider || error?.provider || getMailConfig().provider || null;
  const wrapped = new Error(error?.message || 'Mailer request failed');
  const axiosStatus = Number(error?.response?.status || error?.status || 0) || undefined;
  const smtpResponseCode = Number(error?.responseCode || 0) || undefined;
  const rawCode = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || '').trim();

  wrapped.provider = provider;
  wrapped.status = axiosStatus;
  wrapped.responseCode = smtpResponseCode;
  wrapped.command = error?.command;
  wrapped.errno = error?.errno;
  wrapped.syscall = error?.syscall;

  if (rawCode === 'MAILER_NOT_CONFIGURED' || rawCode === 'EMAIL_STUB_FORBIDDEN' || rawCode === 'EMAIL_STUB_ONLY') {
    wrapped.code = rawCode || 'MAILER_NOT_CONFIGURED';
    wrapped.backendCode = 'MAILER_NOT_CONFIGURED';
    return wrapped;
  }

  if (provider === 'resend') {
    if (rawCode === 'ECONNABORTED' || /timeout|timed out/i.test(message)) {
      wrapped.code = rawCode || 'ECONNABORTED';
      wrapped.backendCode = 'PROVIDER_TIMEOUT';
      return wrapped;
    }
    if (rawCode === 'ERR_BAD_REQUEST' && [401, 403].includes(axiosStatus)) {
      wrapped.code = 'RESEND_AUTH_FAILED';
      wrapped.backendCode = 'RESEND_AUTH_FAILED';
      return wrapped;
    }
    if ([401, 403].includes(axiosStatus)) {
      wrapped.code = 'RESEND_AUTH_FAILED';
      wrapped.backendCode = 'RESEND_AUTH_FAILED';
      return wrapped;
    }
    wrapped.code = rawCode || 'RESEND_REQUEST_FAILED';
    wrapped.backendCode = 'PROVIDER_UNAVAILABLE';
    return wrapped;
  }

  const smtpAuthCodes = new Set(['EAUTH']);
  const smtpConnectCodes = new Set(['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN']);

  if (rawCode === 'ETIMEDOUT' || /timeout|timed out/i.test(message)) {
    wrapped.code = rawCode || 'ETIMEDOUT';
    wrapped.backendCode = 'PROVIDER_TIMEOUT';
    return wrapped;
  }

  if (smtpAuthCodes.has(rawCode) || [530, 534, 535].includes(smtpResponseCode) || /auth/i.test(message)) {
    wrapped.code = rawCode || 'EAUTH';
    wrapped.backendCode = 'SMTP_AUTH_FAILED';
    return wrapped;
  }
  if (smtpConnectCodes.has(rawCode) || [421].includes(smtpResponseCode) || /connect|timed out|timeout|socket/i.test(message)) {
    wrapped.code = rawCode || 'ECONNECTION';
    wrapped.backendCode = 'SMTP_CONNECT_FAILED';
    return wrapped;
  }

  wrapped.code = rawCode || 'SMTP_SEND_FAILED';
  wrapped.backendCode = 'PROVIDER_UNAVAILABLE';
  return wrapped;
}

function getTransporter(provider = getMailConfig().provider) {
  if (!transporters.has(provider)) {
    transporters.set(provider, buildTransport(provider, getMailConfig()));
  }
  return transporters.get(provider);
}

function buildMailOptions(config, provider, options) {
  const mailOptions = {
    from: provider === 'resend' ? config.resendFrom : config.smtpFrom,
    ...options,
  };
  if (provider === 'smtp' && config.smtpEnvelopeFrom) {
    mailOptions.envelope = {
      ...(options && options.envelope ? options.envelope : {}),
      from: (options && options.envelope && options.envelope.from) || config.smtpEnvelopeFrom,
    };
  }
  return mailOptions;
}

async function sendMail(options) {
  const config = getMailConfig();
  const providers = Array.isArray(config.providerOrder) && config.providerOrder.length
    ? [...config.providerOrder]
    : [config.provider];
  let lastError = null;

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const transport = getTransporter(provider);
    if (!transport) {
      lastError = buildMailerConfigError('Email transporter unavailable', { provider });
      continue;
    }

    const mailOptions = buildMailOptions(config, provider, options);
    const start = Date.now();
    try {
      const info = await transport.sendMail(mailOptions);
      const elapsedMs = Date.now() - start;
      console.log('[EMAIL][sent]', JSON.stringify({
        provider: info?.provider || transport.provider || provider,
        providerOrder: providers,
        to: mailOptions.to,
        subject: mailOptions.subject,
        messageId: info?.messageId || null,
        accepted: info?.accepted || [],
        rejected: info?.rejected || [],
        response: info?.response || null,
        envelope: info?.envelope || null,
        elapsedMs,
        ts: new Date().toISOString(),
      }));
      return info;
    } catch (err) {
      const classified = classifyAndWrapMailerError(err, { provider: transport.provider || provider });
      lastError = classified;
      console.error('[EMAIL][send-error]', JSON.stringify({
        provider: classified.provider || transport.provider || provider,
        providerOrder: providers,
        attempt: index + 1,
        to: mailOptions.to,
        subject: mailOptions.subject,
        error: serializeMailError(classified),
        ts: new Date().toISOString(),
      }));
      if (index < providers.length - 1 && classified.backendCode !== 'MAILER_NOT_CONFIGURED') {
        console.warn('[EMAIL][fallback]', JSON.stringify({
          fromProvider: provider,
          toProvider: providers[index + 1],
          backendCode: classified.backendCode || null,
          code: classified.code || null,
        }));
        continue;
      }
      throw classified;
    }
  }

  throw lastError || buildMailerConfigError('Email transporter unavailable', { provider: config.provider });
}

module.exports = {
  classifyAndWrapMailerError,
  getMailConfig,
  getMailerStatus,
  getTransporter,
  sendMail,
};