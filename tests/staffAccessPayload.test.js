const test = require('node:test');
const assert = require('node:assert/strict');

const { parseStaffModuleAccessPayload } = require('../services/founderAccessPolicyService');

test('Staff Access module payload accepts canonical module state map', () => {
  const parsed = parseStaffModuleAccessPayload({
    moduleAccessStates: {
      adsManager: 'enabled',
      dpdpCompliance: 'enabled',
      settings: 'disabled',
      aiEngine: 'temporary',
      complianceReports: 'enabled',
      staffTasks: 'enabled',
    },
  });

  assert.equal(parsed.provided, true);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.states, {
    adsManager: 'enabled',
    dpdpCompliance: 'enabled',
    settings: 'disabled',
    aiEngine: 'temporary',
    complianceReports: 'enabled',
    staffTasks: 'enabled',
  });
  assert.deepEqual(parsed.enabledLegacyKeys.sort(), [
    'ads_manager',
    'compliance_reports',
    'dpdp_compliance',
    'staff_tasks',
  ]);
});

test('Staff Access module payload rejects Admin Panel-only team_management key', () => {
  const parsed = parseStaffModuleAccessPayload({ moduleAccessStates: { team_management: 'enabled' } });

  assert.equal(parsed.provided, true);
  assert.deepEqual(parsed.states, {});
  assert.equal(parsed.errors.length, 1);
  assert.deepEqual(parsed.errors[0], {
    field: 'moduleAccess.team_management',
    reason: 'UNKNOWN_MODULE_KEY',
    key: 'team_management',
  });
});

test('Staff Access module payload rejects assignable Safe Zone access', () => {
  const parsed = parseStaffModuleAccessPayload({ moduleAccessStates: { safeZone: 'enabled' } });

  assert.equal(parsed.provided, true);
  assert.deepEqual(parsed.states, {});
  assert.equal(parsed.errors.length, 1);
  assert.deepEqual(parsed.errors[0], {
    field: 'moduleAccess.safeZone',
    reason: 'FOUNDER_ONLY_MODULE',
    key: 'safeZone',
    canonicalKey: 'safeZone',
    value: 'enabled',
  });
});
