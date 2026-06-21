const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Counter = require('../models/Counter');
const User = require('../models/User');
const { generateStaffId } = require('../lib/staffId');

test('generateStaffId counter upsert does not set value twice on insert', async (testContext) => {
  const originalReadyState = mongoose.connection.readyState;
  const originalDbDescriptor = Object.getOwnPropertyDescriptor(mongoose.connection, 'db');
  const originalFindOneAndUpdate = Counter.findOneAndUpdate;
  const originalUserFindOne = User.findOne;

  let capturedUpdate = null;
  let capturedOptions = null;

  testContext.after(() => {
    mongoose.connection.readyState = originalReadyState;
    if (originalDbDescriptor) {
      Object.defineProperty(mongoose.connection, 'db', originalDbDescriptor);
    } else {
      delete mongoose.connection.db;
    }
    Counter.findOneAndUpdate = originalFindOneAndUpdate;
    User.findOne = originalUserFindOne;
  });

  mongoose.connection.readyState = 1;
  Object.defineProperty(mongoose.connection, 'db', { configurable: true, value: {} });
  Counter.findOneAndUpdate = async (_filter, update, options) => {
    capturedUpdate = update;
    capturedOptions = options;
    return { value: 1 };
  };
  User.findOne = () => ({ lean: async () => null });

  const generated = await generateStaffId({ year: 2026 });

  assert.equal(generated.staffId, 'NP-2026-0001');
  assert.deepEqual(capturedUpdate.$setOnInsert, { key: 'staffId_2026' });
  assert.equal(capturedOptions.setDefaultsOnInsert, false);

  const query = originalFindOneAndUpdate.call(Counter, { key: 'staffId_2026' }, capturedUpdate, capturedOptions);
  query._castUpdate(query.getUpdate());
  assert.equal(Object.prototype.hasOwnProperty.call(query.getUpdate().$setOnInsert || {}, 'value'), false);
});
