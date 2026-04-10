'use strict';

const path = require('path');

try {
  require('dotenv').config({ path: path.join(process.cwd(), '.env') });
} catch (_) {}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index] || '').trim();
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const next = index + 1 < argv.length ? String(argv[index + 1] || '').trim() : '';
    if (!next || next.startsWith('--')) {
      options[key] = 'true';
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function trimOrNull(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function defaultBackendBaseUrl() {
  return trimOrNull(process.env.BACKEND_BASE_URL)
    || trimOrNull(process.env.RENDER_EXTERNAL_URL)
    || trimOrNull(process.env.API_BASE_URL)
    || `http://localhost:${trimOrNull(process.env.PORT) || '5000'}`;
}

function defaultPublicBaseUrl() {
  return trimOrNull(process.env.PUBLIC_BASE_URL)
    || trimOrNull(process.env.APP_BASE_URL)
    || trimOrNull(process.env.SITE_URL)
    || trimOrNull(process.env.REPORTER_PORTAL_BASE_URL);
}

async function postJson(url, { body, headers }) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    traceHeader: response.headers.get('x-reporter-auth-trace'),
    contentType: response.headers.get('content-type'),
    json,
    text,
  };
}

function summarizeProbe(name, result) {
  if (!result) return null;
  return {
    name,
    ok: result.ok,
    status: result.status,
    statusText: result.statusText,
    code: result.json && result.json.code ? result.json.code : null,
    backendCode: result.json && result.json.backendCode ? result.json.backendCode : null,
    traceId: result.json && result.json.traceId ? result.json.traceId : null,
    traceHeader: result.traceHeader || null,
    message: result.json && result.json.message ? result.json.message : null,
    contentType: result.contentType || null,
    rawBody: result.json ? null : result.text,
  };
}

function deriveConclusion(validationProbe, portalValidationProbe, deliveryProbe, publicProbe) {
  const parts = [];

  if (validationProbe && validationProbe.status === 400 && validationProbe.code === 'EMAIL_REQUIRED') {
    parts.push('direct backend validation probe reached request-code and returned the expected handled 400 response');
  } else if (validationProbe) {
    parts.push(`direct backend validation probe returned ${validationProbe.status}${validationProbe.code ? ` (${validationProbe.code})` : ''}`);
  }

  if (portalValidationProbe && portalValidationProbe.status === 400 && portalValidationProbe.code === 'EMAIL_REQUIRED') {
    parts.push('direct backend portal route is mounted and handling validation correctly');
  } else if (portalValidationProbe) {
    parts.push(`direct backend portal route returned ${portalValidationProbe.status}${portalValidationProbe.code ? ` (${portalValidationProbe.code})` : ''}`);
  }

  if (
    validationProbe
    && validationProbe.status === 404
    && portalValidationProbe
    && portalValidationProbe.status === 400
    && portalValidationProbe.code === 'EMAIL_REQUIRED'
  ) {
    parts.push('compat alias appears missing on the live backend while the underlying portal route is healthy');
  }

  if (deliveryProbe) {
    if (deliveryProbe.status === 200) {
      parts.push('direct backend delivery probe accepted the request');
    } else if (deliveryProbe.status === 503 || deliveryProbe.status === 504) {
      parts.push(`direct backend delivery probe failed inside the backend mailer path with ${deliveryProbe.status} (${deliveryProbe.backendCode || deliveryProbe.code || 'unknown'})`);
    } else {
      parts.push(`direct backend delivery probe returned ${deliveryProbe.status}${deliveryProbe.code ? ` (${deliveryProbe.code})` : ''}`);
    }
  }

  if (publicProbe) {
    if (validationProbe && validationProbe.status === 400 && validationProbe.code === 'EMAIL_REQUIRED' && publicProbe.status >= 500) {
      parts.push('public probe failed while direct backend validation remained healthy, which points to a proxy or frontend path issue');
    } else {
      parts.push(`public probe returned ${publicProbe.status}${publicProbe.code ? ` (${publicProbe.code})` : ''}`);
    }
  }

  return parts.join('; ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backendBaseUrl = trimOrNull(args['base-url']) || defaultBackendBaseUrl();
  const publicBaseUrl = trimOrNull(args['public-url']) || defaultPublicBaseUrl();
  const origin = trimOrNull(args.origin) || 'https://www.newspulse.co.in';
  const forwardedHost = trimOrNull(args['forwarded-host']) || 'www.newspulse.co.in';
  const forwardedProto = trimOrNull(args['forwarded-proto']) || 'https';
  const probeEmail = trimOrNull(args.email) || trimOrNull(process.env.REPORTER_AUTH_PROBE_EMAIL);
  const includePublicProbe = String(args.public || '').toLowerCase() === 'true' || !!trimOrNull(args['public-url']);
  const routePath = '/api/reporter-auth/request-code';
  const portalRoutePath = '/api/reporter-portal/auth/request-login-otp';

  const sharedHeaders = {
    'Content-Type': 'application/json',
    Origin: origin,
    'x-forwarded-host': forwardedHost,
    'x-forwarded-proto': forwardedProto,
    'x-vercel-id': 'iad1::reporter-auth-probe',
  };

  const directValidation = summarizeProbe('directValidation', await postJson(`${backendBaseUrl}${routePath}`, {
    headers: sharedHeaders,
    body: { email: '' },
  }));

  const directPortalValidation = summarizeProbe('directPortalValidation', await postJson(`${backendBaseUrl}${portalRoutePath}`, {
    headers: sharedHeaders,
    body: { email: '' },
  }));

  const directDelivery = probeEmail
    ? summarizeProbe('directDelivery', await postJson(`${backendBaseUrl}${routePath}`, {
      headers: sharedHeaders,
      body: { email: probeEmail },
    }))
    : null;

  const publicValidation = includePublicProbe && publicBaseUrl
    ? summarizeProbe('publicValidation', await postJson(`${publicBaseUrl}${routePath}`, {
      headers: sharedHeaders,
      body: { email: '' },
    }))
    : null;

  const output = {
    ok: true,
    route: routePath,
    portalRoute: portalRoutePath,
    backendBaseUrl,
    publicBaseUrl: includePublicProbe ? publicBaseUrl : null,
    probes: {
      directValidation,
      directPortalValidation,
      ...(directDelivery ? { directDelivery } : {}),
      ...(publicValidation ? { publicValidation } : {}),
    },
    conclusion: deriveConclusion(directValidation, directPortalValidation, directDelivery, publicValidation),
  };

  console.log(JSON.stringify(output, null, 2));

  const backendFailed = !directValidation || directValidation.status >= 500 || !directValidation.traceId;
  if (backendFailed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : null,
  }, null, 2));
  process.exitCode = 1;
});