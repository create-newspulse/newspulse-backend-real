const test = require('node:test');
const assert = require('node:assert/strict');

const SystemSetting = require('../models/SystemSetting');
const AuditLog = require('../models/AuditLog');
const { settingsService } = require('../services/settingsService');

test('settingsService.set upsert does not set value twice on insert', async (testContext) => {
  const originalFindOne = SystemSetting.findOne;
  const originalFindOneAndUpdate = SystemSetting.findOneAndUpdate;
  const originalAuditCreate = AuditLog.create;

  let capturedFilter = null;
  let capturedUpdate = null;
  let capturedOptions = null;

  testContext.after(() => {
    SystemSetting.findOne = originalFindOne;
    SystemSetting.findOneAndUpdate = originalFindOneAndUpdate;
    AuditLog.create = originalAuditCreate;
  });

  SystemSetting.findOne = () => ({ lean: async () => null });
  SystemSetting.findOneAndUpdate = async (filter, update, options) => {
    capturedFilter = filter;
    capturedUpdate = update;
    capturedOptions = options;
    return { value: update.$set.value, updatedAt: new Date('2026-06-21T00:00:00.000Z') };
  };
  AuditLog.create = async () => ({});

  const settingKey = 'site.readOnlyMode';
  await settingsService.set(settingKey, true, {
    admin: { id: 'founder-1', email: 'founder@example.com', role: 'founder' },
  });

  assert.deepEqual(capturedFilter, { key: settingKey });
  assert.equal(capturedUpdate.$set.value, true);
  assert.deepEqual(capturedUpdate.$setOnInsert, { key: settingKey });
  assert.equal(capturedOptions.setDefaultsOnInsert, false);

  const query = originalFindOneAndUpdate.call(SystemSetting, capturedFilter, capturedUpdate, capturedOptions);
  query._castUpdate(query.getUpdate());
  assert.equal(Object.prototype.hasOwnProperty.call(query.getUpdate().$setOnInsert || {}, 'value'), false);
});
