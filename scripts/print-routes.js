const request = require('supertest');
const app = require('../server');
(async () => {
  const res = await request(app).get('/_debug/routes');
  console.log('status', res.status);
  console.log(JSON.stringify(res.body, null, 2));
})();