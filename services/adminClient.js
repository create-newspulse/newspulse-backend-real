const axios = require('axios');

/**
 * Admin Axios client with centralized auth handling.
 *
 * Usage:
 *  const client = createAdminClient({ baseURL: 'https://api.example.com', token: 'np.dev-token' });
 *  const res = await client.get('/api/admin/community-reporter/queue', { params: { status: 'pending' } });
 */
function createAdminClient(options = {}) {
  const {
    baseURL = process.env.ADMIN_API_BASE_URL || 'http://localhost:10000',
    token = process.env.ADMIN_API_TOKEN || '',
    withCredentials = !!process.env.ADMIN_API_WITH_CREDENTIALS,
    defaultHeaders = {},
  } = options;

  const client = axios.create({ baseURL, withCredentials, headers: { ...defaultHeaders } });

  // Attach Authorization header if token provided
  client.interceptors.request.use((config) => {
    const t = options.token || token;
    if (t && !config.headers.Authorization) {
      config.headers.Authorization = `Bearer ${t}`;
    }
    return config;
  });

  // Normalize error shape
  client.interceptors.response.use(
    (res) => res,
    (err) => {
      const status = err?.response?.status || 0;
      const data = err?.response?.data || { message: err?.message || 'Request failed' };
      return Promise.reject({ status, data });
    }
  );

  return client;
}

module.exports = { createAdminClient };
