const axios = require('axios');
const nodemailer = require('nodemailer');

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_MAIL_SCOPE = 'default';
const REPORTER_OTP_MAIL_SCOPE = 'reporter-otp';
const transporters = new Map();
const transporterHealth = new Map();

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeMailScope(scope) {
  const normalized = String(scope || '').trim().toLowerCase();
  if (normalized === REPORTER_OTP_MAIL_SCOPE) return REPORTER_OTP_MAIL_SCOPE;
  return DEFAULT_MAIL_SCOPE;
}

function getScopedEnv(scope, ...names) {
  const candidates = [];
  if (normalizeMailScope(scope) === REPORTER_OTP_MAIL_SCOPE) {
    for (const name of names) {
      if (typeof name !== 'string' || !name.trim()) continue;
      candidates.push(`REPORTER_OTP_${name}`);
      candidates.push(`REPORTER_${name}`);
    }
  }

  for (const name of names) {
    if (typeof name !== 'string' || !name.trim()) continue;
    candidates.push(name);
  }

  for (const name of candidates) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  return '';
}

function getMailScopeCacheKey(scope, provider) {
  return `${normalizeMailScope(scope)}:${String(provider || '').trim().toLowerCase()}`;
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

function resolveSmtpSecurity(smtpPort, smtpSecureRaw) {
  const portNumber = smtpPort ? Number(smtpPort) : null;
  const hasExplicitSecure = String(smtpSecureRaw || '').trim() !== '';
  const explicitSecure = hasExplicitSecure ? parseBool(smtpSecureRaw, false) : null;

  if (portNumber === 465) {
    return {
      secure: true,
      adjusted: hasExplicitSecure && explicitSecure === false,
      warning: hasExplicitSecure && explicitSecure === false
        ? 'SMTP_SECURE=false was overridden because SMTP_PORT=465 requires implicit TLS.'
        : null,
      source: 'port-465',
    };
  }

  if (portNumber === 587) {
    return {
      secure: false,
      adjusted: hasExplicitSecure && explicitSecure === true,
      warning: hasExplicitSecure && explicitSecure === true
        ? 'SMTP_SECURE=true was overridden because SMTP_PORT=587 should start non-secure and upgrade with STARTTLS.'
        : null,
      source: 'port-587',
    };
  }

  return {
    secure: parseBool(smtpSecureRaw, portNumber === 465),
    adjusted: false,
    warning: null,
    source: hasExplicitSecure ? 'env' : 'default',
  };
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

function getMailConfig(options = {}) {
  const scope = normalizeMailScope(options.scope);
  const emailMode = getScopedEnv(scope, 'EMAIL_MODE').toLowerCase();
  const preferredProvider = getScopedEnv(scope, 'EMAIL_PROVIDER', 'MAIL_PROVIDER');
  const smtpService = getScopedEnv(scope, 'SMTP_SERVICE', 'ADS_SMTP_SERVICE');
  const smtpHost = getScopedEnv(scope, 'SMTP_HOST', 'ADS_SMTP_HOST');
  const smtpPort = getScopedEnv(scope, 'SMTP_PORT', 'ADS_SMTP_PORT');
  const smtpUser = getScopedEnv(scope, 'SMTP_USER', 'ADS_SMTP_USER');
  const smtpPass = getScopedEnv(scope, 'SMTP_PASS', 'ADS_SMTP_PASS');
  const smtpFrom = firstNonEmpty(
    getScopedEnv(scope, 'MAIL_FROM', 'FROM_EMAIL', 'EMAIL_FROM', 'ADS_SMTP_FROM'),
    smtpUser
  );
  const smtpEnvelopeFrom = getScopedEnv(scope, 'SMTP_FROM');
  const smtpSecure = getScopedEnv(scope, 'SMTP_SECURE', 'ADS_SMTP_SECURE');
  const smtpPool = getScopedEnv(scope, 'SMTP_POOL', 'ADS_SMTP_POOL');
  const smtpMaxConn = getScopedEnv(scope, 'SMTP_MAX_CONN', 'ADS_SMTP_MAX_CONN');
  const smtpDebug = getScopedEnv(scope, 'SMTP_DEBUG', 'ADS_SMTP_DEBUG');
  const resendApiKey = getScopedEnv(scope, 'RESEND_API_KEY');
  const resendFrom = firstNonEmpty(
    getScopedEnv(scope, 'RESEND_FROM'),
    getScopedEnv(scope, 'MAIL_FROM', 'FROM_EMAIL', 'EMAIL_FROM')
  );
  const resendReplyTo = getScopedEnv(scope, 'RESEND_REPLY_TO');
  const appBaseUrl = getScopedEnv(scope, 'REPORTER_PORTAL_BASE_URL', 'APP_BASE_URL', 'SITE_URL', 'PUBLIC_BASE_URL', 'RENDER_EXTERNAL_URL');
  const providerTimeoutMs = toPositiveNumber(getScopedEnv(scope, 'EMAIL_PROVIDER_TIMEOUT_MS'), 10000);
  const smtpPortNumber = smtpPort ? Number(smtpPort) : (smtpService ? null : 587);
  const smtpSecurity = resolveSmtpSecurity(smtpPort, smtpSecure);
  const smtpSecureResolved = smtpSecurity.secure;

  const config = {
    scope,
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
    smtpSecureAdjusted: smtpSecurity.adjusted,
    smtpSecureWarning: smtpSecurity.warning,
    smtpSecureSource: smtpSecurity.source,
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

function getTransportHealth(provider, scope = DEFAULT_MAIL_SCOPE) {
  return transporterHealth.get(getMailScopeCacheKey(scope, provider)) || null;
}

function setTransportHealth(provider, scope, next) {
  const key = getMailScopeCacheKey(scope, provider);
  const previous = transporterHealth.get(key) || {};
  transporterHealth.set(key, {
    ...previous,
    ...next,
    provider,
    scope: normalizeMailScope(scope),
    updatedAt: new Date().toISOString(),
  });
}

function getTransportHealthSnapshot(config) {
  const providers = Array.from(new Set([config.provider, ...(Array.isArray(config.providerOrder) ? config.providerOrder : [])].filter(Boolean)));
  const snapshot = {};
  for (const provider of providers) {
    snapshot[provider] = getTransportHealth(provider, config.scope);
  }
  return snapshot;
}

function getMailerStatus(options = {}) {
  const config = getMailConfig(options);
  return {
    scope: config.scope,
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
      secureAdjusted: config.smtpSecureAdjusted,
      secureSource: config.smtpSecureSource,
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
  error.scope = normalizeMailScope(options.scope);
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
    scope: config.scope,
    provider: 'smtp',
    host: baseConfig.host || baseConfig.service || null,
    port: baseConfig.port || null,
    secure: baseConfig.secure,
    secureAdjusted: config.smtpSecureAdjusted,
    secureSource: config.smtpSecureSource,
    timeoutMs: providerTimeoutMs,
    pool: !!baseConfig.pool,
    fromConfigured: !!config.smtpFrom,
    envelopeFromConfigured: !!config.smtpEnvelopeFrom,
    appBaseUrlConfigured: !!config.appBaseUrl,
    productionLike: isProductionLike(),
  });

  if (config.smtpSecureWarning) {
    console.warn('[EMAIL][config-warning]', JSON.stringify({
      provider: 'smtp',
      warning: config.smtpSecureWarning,
      hostConfigured: !!config.smtpHost,
      serviceConfigured: !!config.smtpService,
      port: baseConfig.port || null,
      secure: baseConfig.secure,
      secureSource: config.smtpSecureSource,
    }));
  }

  setTransportHealth('smtp', config.scope, {
    state: 'initializing',
    backendCode: null,
    error: null,
    metadata: {
      host: baseConfig.host || baseConfig.service || null,
      port: baseConfig.port || null,
      secure: baseConfig.secure,
      secureAdjusted: config.smtpSecureAdjusted,
      timeoutMs: providerTimeoutMs,
      pool: !!baseConfig.pool,
      fromConfigured: !!config.smtpFrom,
    },
  });

  const transport = nodemailer.createTransport(baseConfig);
  transport.provider = 'smtp';
  transport.scope = config.scope;

  transport.verify().then(() => {
    console.log('[EMAIL][transporter-ready]', {
      scope: config.scope,
      provider: 'smtp',
      host: baseConfig.host || baseConfig.service || null,
      port: baseConfig.port || null,
      secure: baseConfig.secure,
      pool: !!baseConfig.pool,
      userConfigured: !!config.smtpUser,
    });
    setTransportHealth('smtp', config.scope, {
      state: 'ready',
      backendCode: null,
      error: null,
    });
  }).catch((err) => {
    const classified = classifyAndWrapMailerError(err, { provider: 'smtp' });
    console.error('[EMAIL][verify-fail]', JSON.stringify(serializeMailError(classified)));
    setTransportHealth('smtp', config.scope, {
      state: 'failed',
      backendCode: classified.backendCode || null,
      error: serializeMailError(classified),
    });
  });

  return transport;
}

function buildResendTransport(config) {
  console.log('[EMAIL][transporter-init]', {
    scope: config.scope,
    provider: 'resend',
    fromConfigured: !!config.resendFrom,
    replyToConfigured: !!config.resendReplyTo,
    timeoutMs: config.providerTimeoutMs,
    appBaseUrlConfigured: !!config.appBaseUrl,
    productionLike: isProductionLike(),
  });

  setTransportHealth('resend', config.scope, {
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
    scope: config.scope,
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
          scope: config.scope,
          provider: 'resend',
          fromConfigured: !!config.resendFrom,
          replyToConfigured: !!config.resendReplyTo,
        });
        setTransportHealth('resend', config.scope, {
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
        setTransportHealth('resend', config.scope, {
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
      scope: config.scope,
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
          scope: config.scope,
        });
      },
    };
  }

  if (!config.configured) {
    console.error('[EMAIL][config-error] Missing required env vars:', config.missing.join(', '));
    throw buildMailerConfigError(`Email service not configured: ${config.missing.join(', ')}`, {
      provider: config.provider,
      missing: config.missing,
      scope: config.scope,
    });
  }

  if (provider === 'resend') {
    return buildResendTransport(config);
  }

  return buildSmtpTransport(config);
}

function classifyAndWrapMailerError(error, options = {}) {
  const provider = options.provider || error?.provider || getMailConfig(options).provider || null;
  const wrapped = new Error(error?.message || 'Mailer request failed');
  const axiosStatus = Number(error?.response?.status || error?.status || 0) || undefined;
  const smtpResponseCode = Number(error?.responseCode || 0) || undefined;
  const rawCode = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || '').trim();

  wrapped.provider = provider;
  wrapped.scope = normalizeMailScope(options.scope || error?.scope);
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

function getTransporter(provider, options = {}) {
  const config = getMailConfig(options);
  const resolvedProvider = provider || config.provider;
  const key = getMailScopeCacheKey(config.scope, resolvedProvider);
  if (!transporters.has(key)) {
    transporters.set(key, buildTransport(resolvedProvider, config));
  }
  return transporters.get(key);
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

async function sendMail(options, mailerOptions = {}) {
  const config = getMailConfig(mailerOptions);
  const providers = Array.isArray(config.providerOrder) && config.providerOrder.length
    ? [...config.providerOrder]
    : [config.provider];
  let lastError = null;

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const transport = getTransporter(provider, { scope: config.scope });
    if (!transport) {
      lastError = buildMailerConfigError('Email transporter unavailable', { provider, scope: config.scope });
      continue;
    }

    const mailOptions = buildMailOptions(config, provider, options);
    const start = Date.now();
    try {
      const info = await transport.sendMail(mailOptions);
      const elapsedMs = Date.now() - start;
      console.log('[EMAIL][sent]', JSON.stringify({
        scope: config.scope,
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
      const classified = classifyAndWrapMailerError(err, { provider: transport.provider || provider, scope: config.scope });
      lastError = classified;
      console.error('[EMAIL][send-error]', JSON.stringify({
        scope: config.scope,
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
          scope: config.scope,
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

  throw lastError || buildMailerConfigError('Email transporter unavailable', { provider: config.provider, scope: config.scope });
}

module.exports = {
  classifyAndWrapMailerError,
  DEFAULT_MAIL_SCOPE,
  getMailConfig,
  getMailerStatus,
  getTransporter,
  REPORTER_OTP_MAIL_SCOPE,
  sendMail,
};