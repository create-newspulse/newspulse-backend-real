const { initializeApp, getApps, cert, applicationDefault } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

let appModule = { initializeApp, getApps, cert, applicationDefault };
let messagingModule = { getMessaging };

let state = {
  attempted: false,
  app: null,
  error: null,
  status: 'not_configured',
  projectId: null,
  credentialSource: null,
};

function trimEnv(value) {
  return String(value || '').trim();
}

function normalizePrivateKey(value) {
  const raw = trimEnv(value);
  if (!raw) return '';
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return unquoted.replace(/\\n/g, '\n');
}

function getCredentialConfig() {
  const projectId = trimEnv(process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT);
  const clientEmail = trimEnv(process.env.FIREBASE_CLIENT_EMAIL);
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
  const googleApplicationCredentials = trimEnv(process.env.GOOGLE_APPLICATION_CREDENTIALS);

  if (projectId && clientEmail && privateKey) {
    return {
      configured: true,
      projectId,
      credentialSource: 'env_service_account',
      options: {
        projectId,
        credential: appModule.cert({ projectId, clientEmail, privateKey }),
      },
    };
  }

  if (googleApplicationCredentials && projectId) {
    return {
      configured: true,
      projectId,
      credentialSource: 'google_application_credentials',
      options: {
        projectId,
        credential: appModule.applicationDefault(),
      },
    };
  }

  return {
    configured: false,
    projectId: projectId || null,
    credentialSource: null,
    missing: [
      !projectId ? 'FIREBASE_PROJECT_ID' : null,
      !clientEmail && !googleApplicationCredentials ? 'FIREBASE_CLIENT_EMAIL' : null,
      !privateKey && !googleApplicationCredentials ? 'FIREBASE_PRIVATE_KEY' : null,
    ].filter(Boolean),
  };
}

function getFirebaseAdminApp() {
  if (state.attempted) return state.app;
  state.attempted = true;

  try {
    const existingApps = appModule.getApps();
    if (Array.isArray(existingApps) && existingApps.length > 0) {
      state = {
        ...state,
        app: existingApps[0],
        status: 'configured',
        projectId: existingApps[0]?.options?.projectId || trimEnv(process.env.FIREBASE_PROJECT_ID) || null,
        credentialSource: 'existing_app',
      };
      return state.app;
    }

    const config = getCredentialConfig();
    if (!config.configured) {
      state = {
        ...state,
        status: 'not_configured',
        projectId: config.projectId || null,
        credentialSource: null,
      };
      return null;
    }

    const app = appModule.initializeApp(config.options);
    state = {
      ...state,
      app,
      status: 'configured',
      projectId: config.projectId,
      credentialSource: config.credentialSource,
    };
    return app;
  } catch (error) {
    state = {
      ...state,
      app: null,
      error,
      status: 'initialization_error',
      projectId: trimEnv(process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT) || null,
    };
    return null;
  }
}

function getFirebaseMessagingClient() {
  const app = getFirebaseAdminApp();
  if (!app) return null;
  try {
    return messagingModule.getMessaging(app);
  } catch (error) {
    state = {
      ...state,
      error,
      status: 'initialization_error',
    };
    return null;
  }
}

function getFirebaseAdminStatus() {
  const app = getFirebaseAdminApp();
  return {
    configured: state.status === 'configured' && !!app,
    status: state.status,
    messagingAvailable: state.status === 'configured' && !!app,
    projectId: state.projectId || null,
    credentialSource: state.credentialSource || null,
    error: state.status === 'initialization_error' ? String(state.error?.message || state.error || 'Firebase initialization failed') : null,
  };
}

function resetFirebaseAdminForTests() {
  state = {
    attempted: false,
    app: null,
    error: null,
    status: 'not_configured',
    projectId: null,
    credentialSource: null,
  };
}

function setFirebaseAdminModulesForTests(modules = {}) {
  appModule = modules.appModule || appModule;
  messagingModule = modules.messagingModule || messagingModule;
  resetFirebaseAdminForTests();
}

module.exports = {
  getFirebaseAdminApp,
  getFirebaseMessagingClient,
  getFirebaseAdminStatus,
  normalizePrivateKey,
  resetFirebaseAdminForTests,
  setFirebaseAdminModulesForTests,
};