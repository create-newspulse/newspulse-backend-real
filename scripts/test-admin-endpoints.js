const request = require('supertest');
const app = require('../server');

(async () => {
  const cookie = 'np_admin=admin%40newspulse.ai';

  const reportersRes = await request(app)
    .get('/api/admin/reporters?district=all&areaType=all&beat=all&activity=all&page=1&limit=5')
    .set('Cookie', cookie);
  console.log('GET /api/admin/reporters ->', reportersRes.status, reportersRes.body && reportersRes.body.ok);
  console.log('items:', Array.isArray(reportersRes.body.items) ? reportersRes.body.items.length : 'n/a', 'total:', reportersRes.body.total);

  const queueRes = await request(app)
    .get('/api/admin/community-reporter/queue?status=pending')
    .set('Cookie', cookie);
  console.log('GET /api/admin/community-reporter/queue?status=pending ->', queueRes.status, queueRes.body && queueRes.body.ok);
  console.log('items:', Array.isArray(queueRes.body.items) ? queueRes.body.items.length : 'n/a');

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
