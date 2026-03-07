const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.OPENWEATHER_API_KEY = 'test-openweather-key';

const app = require('../server');

function assertMinimalShape(body) {
  assert.equal(typeof body, 'object');
  assert.ok(body);
  assert.equal(typeof body.city, 'string');
  // numbers can be null when upstream data missing
  for (const k of ['tempC', 'feelsLikeC', 'humidity', 'windKmph']) {
    assert.ok(body[k] === null || typeof body[k] === 'number', `${k} should be number|null`);
  }
  assert.ok(body.condition === null || typeof body.condition === 'string');
  assert.ok(body.icon === null || typeof body.icon === 'string');
  assert.equal(typeof body.updatedAt, 'string');
}

test('GET /api/public/weather/current returns minimal shape and caches by city for 10 minutes', async () => {
  const prevFetch = global.fetch;

  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    assert.ok(String(url).includes('/data/2.5/weather?'), 'should call current weather endpoint');
    assert.ok(String(url).includes('units=metric'), 'should request units=metric');

    return {
      ok: true,
      status: 200,
      json: async () => ({
        name: 'London',
        dt: 1700000000,
        main: { temp: 17.2, feels_like: 16.5, humidity: 70 },
        wind: { speed: 3 },
        weather: [{ main: 'Clouds', description: 'overcast clouds', icon: '04d' }],
      }),
    };
  };

  try {
    const r1 = await request(app).get('/api/public/weather/current?city=London');
    assert.equal(r1.statusCode, 200);
    assertMinimalShape(r1.body);
    assert.equal(r1.body.city, 'London');
    assert.equal(calls, 1);

    // Second call should be served from cache (no extra fetch call)
    const r2 = await request(app).get('/api/public/weather/current?city= London ');
    assert.equal(r2.statusCode, 200);
    assertMinimalShape(r2.body);
    assert.equal(r2.body.city, 'London');
    assert.equal(calls, 1);
  } finally {
    global.fetch = prevFetch;
  }
});

test('GET /api/public/weather/forecast returns minimal shape (first forecast item)', async () => {
  const prevFetch = global.fetch;

  global.fetch = async (url) => {
    assert.ok(String(url).includes('/data/2.5/forecast?'), 'should call forecast endpoint');
    assert.ok(String(url).includes('units=metric'), 'should request units=metric');

    return {
      ok: true,
      status: 200,
      json: async () => ({
        city: { name: 'Mumbai' },
        list: [
          {
            dt: 1700003600,
            main: { temp: 29.1, feels_like: 32.2, humidity: 80 },
            wind: { speed: 4 },
            weather: [{ main: 'Rain', description: 'light rain', icon: '10d' }],
          },
        ],
      }),
    };
  };

  try {
    const r1 = await request(app).get('/api/public/weather/forecast?city=Mumbai');
    assert.equal(r1.statusCode, 200);
    assertMinimalShape(r1.body);
    assert.equal(r1.body.city, 'Mumbai');
  } finally {
    global.fetch = prevFetch;
  }
});

test('GET /api/public/weather/current returns 429 after light rate limit', async () => {
  // This test is intentionally simple: it validates the limiter trips at all.
  // It uses a stubbed fetch so it does not hit network.
  const prevFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      name: 'TestCity',
      dt: 1700000000,
      main: { temp: 20, feels_like: 20, humidity: 50 },
      wind: { speed: 1 },
      weather: [{ main: 'Clear', icon: '01d' }],
    }),
  });

  try {
    // Best-effort: exceed max=60 within a tight loop.
    let last = null;
    for (let i = 0; i < 80; i++) {
      last = await request(app).get('/api/public/weather/current?city=TestCity2');
      if (last.statusCode === 429) break;
    }

    assert.ok(last);
    assert.equal(last.statusCode, 429);
    assert.equal(typeof last.body?.message, 'string');
  } finally {
    global.fetch = prevFetch;
  }
});
