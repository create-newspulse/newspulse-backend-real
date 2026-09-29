const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../../models/User');
const AuditLog = require('../../models/AuditLog');

function accountAuthFixture() {
  const accounts = new Map();
  return {
    install(context) {
      accounts.clear();
      const state = mongoose.connection.readyState;
      mongoose.connection.readyState = 1;
      context.after(() => { mongoose.connection.readyState = state; });
      const query = value => ({ lean: async () => value, select() { return this; }, then(resolve) { return Promise.resolve(value).then(resolve); } });
      context.mock.method(User, 'findById', id => query(accounts.get(String(id)) || null));
      context.mock.method(User, 'findOne', filter => query([...accounts.values()].find(user => user.email === filter.email) || null));
      context.mock.method(AuditLog, 'create', async () => ({}));
    },
    token(role = 'founder', overrides = {}, secret = process.env.JWT_SECRET) {
      const id = crypto.createHash('sha256').update(role).digest('hex').slice(0, 24);
      const user = { _id: id, email: role.replace(/\W/g, '') + '@example.invalid', role, status: 'active', accountStatus: 'active', tokenVersion: 0 };
      accounts.set(id, user);
      return jwt.sign({ sub: id, email: user.email, role, type: 'access', tokenVersion: 0, ...overrides }, secret, { expiresIn: '5m' });
    },
  };
}

module.exports = { accountAuthFixture };