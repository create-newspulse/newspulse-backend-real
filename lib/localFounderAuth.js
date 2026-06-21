const DEFAULT_LOCAL_FOUNDER = Object.freeze({
  email: 'kiran@newspulse.co.in',
  password: 'Safe!2025@News',
  fullName: 'NewsPulse Founder',
});

function runtimeEnv() {
  return String(process.env.NODE_ENV || 'development').toLowerCase();
}

function isProductionLike() {
  const env = runtimeEnv();
  const isRender = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
  return env === 'production' || isRender;
}

function isLocalDevLike() {
  const env = runtimeEnv();
  return !isProductionLike() && env !== 'test';
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function pickValue(candidates, transform) {
  for (const candidate of candidates) {
    const value = transform(candidate.value);
    if (value) {
      return { value, source: candidate.source };
    }
  }
  return { value: '', source: null };
}

function resolveLocalFounderSeedConfig(body, options = {}) {
  const payload = (body && typeof body === 'object') ? body : {};
  const allowFallbackDefaults = typeof options.allowFallbackDefaults === 'boolean'
    ? options.allowFallbackDefaults
    : isLocalDevLike();

  const emailResult = pickValue([
    { value: payload.email, source: 'body.email' },
    { value: process.env.ADMIN_SEED_FOUNDER_EMAIL, source: 'env.ADMIN_SEED_FOUNDER_EMAIL' },
    { value: process.env.ADMIN_EMAIL, source: 'env.ADMIN_EMAIL' },
    { value: process.env.FOUNDER_EMAIL, source: 'env.FOUNDER_EMAIL' },
    ...(allowFallbackDefaults ? [{ value: DEFAULT_LOCAL_FOUNDER.email, source: 'fallback.defaultEmail' }] : []),
  ], normalizeEmail);

  const passwordResult = pickValue([
    { value: payload.password, source: 'body.password' },
    { value: process.env.ADMIN_SEED_FOUNDER_PASSWORD, source: 'env.ADMIN_SEED_FOUNDER_PASSWORD' },
    { value: process.env.ADMIN_PASSWORD, source: 'env.ADMIN_PASSWORD' },
    { value: process.env.ADMIN_PASS, source: 'env.ADMIN_PASS' },
    { value: process.env.FOUNDER_PASSWORD, source: 'env.FOUNDER_PASSWORD' },
    { value: process.env.FOUNDER_PASS, source: 'env.FOUNDER_PASS' },
    ...(allowFallbackDefaults ? [{ value: DEFAULT_LOCAL_FOUNDER.password, source: 'fallback.defaultPassword' }] : []),
  ], (value) => String(value || '').trim());

  const fullNameResult = pickValue([
    { value: payload.fullName, source: 'body.fullName' },
    { value: payload.name, source: 'body.name' },
    { value: process.env.ADMIN_SEED_FOUNDER_NAME, source: 'env.ADMIN_SEED_FOUNDER_NAME' },
    { value: process.env.FOUNDER_NAME, source: 'env.FOUNDER_NAME' },
    ...(allowFallbackDefaults ? [{ value: DEFAULT_LOCAL_FOUNDER.fullName, source: 'fallback.defaultName' }] : []),
  ], (value) => String(value || '').trim());

  return {
    email: emailResult.value,
    password: passwordResult.value,
    fullName: fullNameResult.value,
    role: 'founder',
    emailSource: emailResult.source,
    passwordSource: passwordResult.source,
    nameSource: fullNameResult.source,
    usesFallbackEmail: emailResult.source === 'fallback.defaultEmail',
    usesFallbackPassword: passwordResult.source === 'fallback.defaultPassword',
    usesFallbackName: fullNameResult.source === 'fallback.defaultName',
    seedRouteEnabled: !isProductionLike(),
    allowFallbackDefaults,
  };
}

function getLocalFounderSafeDiagnostics(body, options) {
  const config = resolveLocalFounderSeedConfig(body, options);
  return {
    email: config.email,
    fullName: config.fullName,
    role: config.role,
    emailSource: config.emailSource,
    passwordSource: config.passwordSource,
    nameSource: config.nameSource,
    usesFallbackEmail: config.usesFallbackEmail,
    usesFallbackPassword: config.usesFallbackPassword,
    usesFallbackName: config.usesFallbackName,
    seedRouteEnabled: config.seedRouteEnabled,
    loginRoute: '/admin-api/admin/login',
    seedRoutes: ['/api/admin/seed-founder', '/admin-api/admin/seed-founder'],
  };
}

module.exports = {
  DEFAULT_LOCAL_FOUNDER,
  getLocalFounderSafeDiagnostics,
  isLocalDevLike,
  isProductionLike,
  normalizeEmail,
  resolveLocalFounderSeedConfig,
};