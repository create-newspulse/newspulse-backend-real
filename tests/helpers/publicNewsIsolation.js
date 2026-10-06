const systemVariables = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'NODE_TEST_CONTEXT',
]);

for (const name of Object.keys(process.env)) {
  if (!systemVariables.has(name.toUpperCase())) delete process.env[name];
}
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'public-news-unit-test-only-not-production';
process.env.NEWSPULSE_ALLOW_REDIS_IN_TESTS = 'false';

// Existing integration tests import server.js, which otherwise reads the local .env.
require('dotenv').config = () => ({ parsed: {} });

const mongoose = require('mongoose');
const refuseDatabase = () => { throw new Error('Database connections are disabled in public news fixture tests'); };
mongoose.Connection.prototype.openUri = refuseDatabase;
mongoose.mongo.MongoClient.prototype.connect = refuseDatabase;

const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object'
    ? first : { host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  const host = options.host || options.hostname || 'localhost';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('Non-loopback connections are disabled in public news fixture tests');
  }
  return connect.apply(this, args);
};
