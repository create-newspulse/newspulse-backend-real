const { createAdminClient } = require('../services/adminClient');

async function main() {
  const baseURL = process.env.ADMIN_API_BASE_URL || 'http://localhost:10000';
  const token = process.env.ADMIN_API_TOKEN || 'np.dev-admin-token';
  const status = process.env.QUEUE_STATUS || 'pending';

  const client = createAdminClient({ baseURL, token });
  try {
    const res = await client.get('/api/admin/community-reporter/queue', { params: { status } });
    const { items = [], meta = {} } = res.data || {};
    console.log('[OK]', res.status, `items=${items.length}`, meta);
    // Print first 3 items for quick inspection
    console.log(JSON.stringify(items.slice(0, 3), null, 2));
  } catch (err) {
    console.error('[ERROR]', err.status || 0, err.data || err.message || err);
    process.exitCode = 1;
  }
}

main();
