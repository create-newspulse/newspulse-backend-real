process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'session-store-test-secret';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const session = require('express-session');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const {
  DEFAULT_SESSION_KEY_PREFIX,
  RedisSessionStore,
  createExpressSessionStore,
} = require('../lib/expressSessionStore');
const { shouldConnectRedis } = require('../lib/redis');
const { requireAdminAuth, requireFounderAuth } = require('../middleware/adminAuth');

class FakeRedisClient {
  constructor() {
    this.commands = [];
    this.store = new Map();
  }

  async get(key) {
    this.commands.push({ command: 'get', key });
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key, value, mode, ttlSeconds) {
    this.commands.push({ command: 'set', key, mode, ttlSeconds });
    assert.strictEqual(mode, 'EX');
    this.store.set(key, {
      value,
      expiresAtMs: Date.now() + ttlSeconds * 1000,
      ttlSeconds,
    });
    return 'OK';
  }

  async del(key) {
    this.commands.push({ command: 'del', key });
    const existed = this.store.delete(key);
    return existed ? 1 : 0;
  }

  async expire(key, ttlSeconds) {
    this.commands.push({ command: 'expire', key, ttlSeconds });
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAtMs = Date.now() + ttlSeconds * 1000;
    entry.ttlSeconds = ttlSeconds;
    return 1;
  }
}

function buildSessionApp(store) {
  const app = express();
  app.use(express.json());
  app.use(session({
    name: 'sid',
    secret: 'local-session-test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000, sameSite: 'lax', secure: false },
    store,
  }));

  app.post('/login', (req, res) => {
    req.session.account = { email: 'reporter@example.com', role: 'reporter' };
    return res.status(204).end();
  });

  app.get('/me', (req, res) => {
    if (!req.session.account) return res.status(401).json({ ok: false });
    return res.json({ ok: true, account: req.session.account });
  });

  app.post('/logout', (req, res) => {
    req.session.destroy((error) => {
      if (error) return res.status(500).json({ ok: false });
      return res.json({ ok: true });
    });
  });

  return app;
}

test('production session store uses Redis/Valkey with the News Pulse namespace', async () => {
  const client = new FakeRedisClient();
  const store = createExpressSessionStore({ client, productionLike: true, ttlMs: 1000 });

  assert.ok(store instanceof RedisSessionStore);
  assert.strictEqual(store.prefix, DEFAULT_SESSION_KEY_PREFIX);

  await new Promise((resolve, reject) => {
    store.set('session-id-1', { cookie: { maxAge: 1500 }, user: { id: 'u1' } }, (error) => (error ? reject(error) : resolve()));
  });

  const setCommand = client.commands.find((command) => command.command === 'set');
  assert.ok(setCommand.key.startsWith('np:session:'));
  assert.strictEqual(setCommand.ttlSeconds, 2);
});

test('test/local session setup does not contact production Redis by default', () => {
  assert.strictEqual(shouldConnectRedis({ NODE_ENV: 'test', REDIS_URL: 'redis://prod.example.invalid:6379' }), false);
  assert.strictEqual(shouldConnectRedis({ NODE_ENV: 'test', REDIS_URL: 'redis://test.example.invalid:6379', NEWSPULSE_ALLOW_REDIS_IN_TESTS: '1' }), true);
  assert.strictEqual(createExpressSessionStore({ client: null, productionLike: false }), undefined);
});

test('production session setup fails clearly when Redis/Valkey is unavailable', () => {
  assert.throws(
    () => createExpressSessionStore({ client: null, productionLike: true }),
    /Redis\/Valkey session store is required in production/
  );
});

test('Redis-backed sessions persist across requests, refresh TTL, and destroy on logout', async () => {
  const client = new FakeRedisClient();
  const store = createExpressSessionStore({ client, productionLike: true, ttlMs: 1000 });
  const app = buildSessionApp(store);
  const agent = request.agent(app);

  const loginRes = await agent.post('/login').send({});
  assert.strictEqual(loginRes.statusCode, 204);

  const sessionKey = Array.from(client.store.keys()).find((key) => key.startsWith(DEFAULT_SESSION_KEY_PREFIX));
  assert.ok(sessionKey);
  assert.strictEqual(client.commands.find((command) => command.command === 'set').ttlSeconds, 1);

  const meRes = await agent.get('/me');
  assert.strictEqual(meRes.statusCode, 200);
  assert.strictEqual(meRes.body.account.email, 'reporter@example.com');
  assert.ok(client.commands.some((command) => command.command === 'expire' && command.key === sessionKey && command.ttlSeconds === 1));

  const logoutRes = await agent.post('/logout').send({});
  assert.strictEqual(logoutRes.statusCode, 200);
  assert.strictEqual(client.store.has(sessionKey), false);
  assert.ok(client.commands.some((command) => command.command === 'del' && command.key === sessionKey));

  const afterLogoutRes = await agent.get('/me');
  assert.strictEqual(afterLogoutRes.statusCode, 401);
});

test('admin, staff, and Founder auth middleware keep accepting current JWT login flow', async () => {
  const app = express();
  app.get('/admin', requireAdminAuth, (req, res) => res.json({ ok: true, role: req.admin.role }));
  app.get('/founder', requireFounderAuth, (req, res) => res.json({ ok: true, role: req.admin.role }));

  const adminToken = jwt.sign({ sub: 'admin-1', email: 'admin@example.com', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const staffToken = jwt.sign({ sub: 'staff-1', email: 'staff@example.com', role: 'reporter' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const founderToken = jwt.sign({ sub: 'founder-1', email: 'founder@example.com', role: 'founder' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const adminRes = await request(app).get('/admin').set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(adminRes.statusCode, 200);
  assert.strictEqual(adminRes.body.role, 'admin');

  const staffRes = await request(app).get('/admin').set('Authorization', `Bearer ${staffToken}`);
  assert.strictEqual(staffRes.statusCode, 200);
  assert.strictEqual(staffRes.body.role, 'reporter');

  const adminFounderRes = await request(app).get('/founder').set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(adminFounderRes.statusCode, 403);

  const founderRes = await request(app).get('/founder').set('Authorization', `Bearer ${founderToken}`);
  assert.strictEqual(founderRes.statusCode, 200);
  assert.strictEqual(founderRes.body.role, 'founder');
});