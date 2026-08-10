const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const { logAudit } = require('../lib/audit');
const marketing = require('../services/marketingPhase4.service');

const router = express.Router();

function actor(req) {
  return req.admin || req.user || null;
}

function hasMarketingAccess(req, permission) {
  const user = actor(req);
  if (!user) return false;
  if (user.isFounder || String(user.role || '').toLowerCase() === 'founder') return true;
  const permissions = Array.isArray(user.permissions) ? user.permissions : [];
  const rights = Array.isArray(user.specialRights) ? user.specialRights : [];
  return permissions.includes(permission) || rights.includes(permission);
}

function requireMarketingPermission(permission) {
  return (req, res, next) => {
    if (hasMarketingAccess(req, permission)) return next();
    return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Access denied' });
  };
}

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      return await handler(req, res, next);
    } catch (error) {
      return res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: 'Server error' });
    }
  };
}

function canViewDealValues(req) {
  return hasMarketingAccess(req, 'view_marketing_deal_values');
}

function canApproveReport(req) {
  return hasMarketingAccess(req, 'approve_campaign_report');
}

function sendResult(res, result) {
  return res.status(result.status || 200).json(result.body || { ok: true });
}

async function sendAudited(req, res, result) {
  if (result.audit) {
    await logAudit(req, result.audit.action, result.audit.targetId || null, {
      module: 'marketing',
      targetType: result.audit.targetType || null,
      targetId: result.audit.targetId || null,
      oldValue: result.audit.oldValue || null,
      newValue: result.audit.newValue || null,
    });
  }
  return sendResult(res, result);
}

async function sendAuditEvents(req, res, result) {
  const events = Array.isArray(result.auditEvents) ? result.auditEvents : [];
  for (const event of events) {
    await logAudit(req, event.action, event.targetId || null, {
      module: 'marketing',
      targetType: event.targetType || null,
      targetId: event.targetId || null,
      oldValue: event.oldValue || null,
      newValue: event.newValue || null,
    });
  }
  return sendResult(res, result);
}

async function sendCsv(req, res, result) {
  if (result.csv == null) return sendResult(res, result);
  await logAudit(req, 'MARKETING_PERFORMANCE_EXPORT', null, {
    module: 'marketing',
    targetType: 'marketing_export',
    targetId: result.filename,
    exportKind: result.filename,
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  return res.status(result.status || 200).send(result.csv);
}

router.use(requireAdminAuth);

router.get('/', requireMarketingPermission('view_marketing_performance'), asyncRoute(async (_req, res) => sendResult(res, await marketing.performanceSummary())));
router.get('/performance/sources', requireMarketingPermission('view_marketing_performance'), asyncRoute(async (_req, res) => {
  const sources = await marketing.getDataSourceStatus();
  return res.status(200).json({ ok: true, sources });
}));

router.get('/performance/summary', requireMarketingPermission('view_marketing_performance'), asyncRoute(async (_req, res) => sendResult(res, await marketing.performanceSummary())));
router.get('/performance/campaigns/export.csv', requireMarketingPermission('export_marketing_performance'), asyncRoute(async (req, res) => sendCsv(req, res, await marketing.exportCsv('campaign-performance', req.query, canViewDealValues(req)))));
router.get('/performance/promotions/export.csv', requireMarketingPermission('export_marketing_performance'), asyncRoute(async (req, res) => sendCsv(req, res, await marketing.exportCsv('promotions', req.query, canViewDealValues(req)))));
router.get('/performance/advertiser-campaign-summary/export.csv', requireMarketingPermission('export_marketing_performance'), asyncRoute(async (req, res) => sendCsv(req, res, await marketing.exportCsv('advertiser-campaign-summary', req.query, canViewDealValues(req)))));
router.get('/performance/campaigns', requireMarketingPermission('view_campaign_performance'), asyncRoute(async (req, res) => sendResult(res, await marketing.listCampaignPerformance(req.query))));
router.get('/performance/campaigns/:id', requireMarketingPermission('view_campaign_performance'), asyncRoute(async (req, res) => sendResult(res, await marketing.getCampaignPerformance(req.params.id))));
router.get('/performance/promotions', requireMarketingPermission('view_promotion_performance'), asyncRoute(async (req, res) => sendResult(res, await marketing.promotionPerformance(req.query))));
router.get('/performance/growth-goals', requireMarketingPermission('view_growth_performance'), asyncRoute(async (req, res) => sendAuditEvents(req, res, await marketing.growthGoalPerformance(req))));
router.get('/performance/retention', requireMarketingPermission('view_marketing_performance'), asyncRoute(async (req, res) => sendResult(res, await marketing.retentionMetrics(canViewDealValues(req)))));

router.get('/campaign-reports', requireMarketingPermission('view_campaign_performance'), asyncRoute(async (req, res) => sendResult(res, await marketing.listCampaignReports(req.query, canViewDealValues(req)))));
router.post('/campaign-reports', requireMarketingPermission('create_campaign_report'), asyncRoute(async (req, res) => sendAudited(req, res, await marketing.createCampaignReport(req.body, req))));
router.get('/campaign-reports/:id', requireMarketingPermission('view_campaign_performance'), asyncRoute(async (req, res) => sendResult(res, await marketing.getCampaignReport(req.params.id, canViewDealValues(req)))));
router.patch('/campaign-reports/:id', requireMarketingPermission('create_campaign_report'), asyncRoute(async (req, res) => sendResult(res, await marketing.updateCampaignReport(req.params.id, req.body, req))));
router.post('/campaign-reports/:id/refresh-performance', requireMarketingPermission('create_campaign_report'), asyncRoute(async (req, res) => sendAudited(req, res, await marketing.refreshCampaignReportPerformance(req.params.id, req))));
router.post('/campaign-reports/:id/status', requireMarketingPermission('create_campaign_report'), asyncRoute(async (req, res) => sendAudited(req, res, await marketing.transitionCampaignReport(req.params.id, req.body, req, canApproveReport(req), hasMarketingAccess(req, 'delete_campaign_report')))));
router.post('/campaign-reports/:id/archive', requireMarketingPermission('delete_campaign_report'), asyncRoute(async (req, res) => sendAudited(req, res, await marketing.transitionCampaignReport(req.params.id, { status: 'archived' }, req, canApproveReport(req), true))));
router.post('/campaign-reports/:id/shared', requireMarketingPermission('create_campaign_report'), asyncRoute(async (req, res) => sendAudited(req, res, await marketing.markCampaignReportShared(req.params.id, req.body, req, canApproveReport(req)))));

router.get('/renewals/export.csv', requireMarketingPermission('export_marketing_performance'), asyncRoute(async (req, res) => sendCsv(req, res, await marketing.exportCsv('renewals', req.query, canViewDealValues(req)))));
router.get('/renewals', requireMarketingPermission('view_renewals'), asyncRoute(async (req, res) => sendResult(res, await marketing.listRenewals(req.query, canViewDealValues(req)))));
router.post('/renewals', requireMarketingPermission('manage_renewals'), asyncRoute(async (req, res) => sendAudited(req, res, await marketing.createRenewal(req.body, req))));
router.get('/renewals/:id', requireMarketingPermission('view_renewals'), asyncRoute(async (req, res) => sendResult(res, await marketing.getRenewal(req.params.id, canViewDealValues(req), hasMarketingAccess(req, 'view_campaign_performance')))));
router.patch('/renewals/:id/status', requireMarketingPermission('manage_renewals'), asyncRoute(async (req, res) => sendAudited(req, res, await marketing.updateRenewalStatus(req.params.id, req.body, req))));
router.post('/renewals/:id/archive', requireMarketingPermission('delete_renewal_record'), asyncRoute(async (req, res) => sendAudited(req, res, await marketing.archiveRenewal(req.params.id, req))));
router.post('/renewals/:id/create-proposal', requireMarketingPermission('manage_renewals'), asyncRoute(async (req, res) => sendAudited(req, res, await marketing.createProposalFromRenewal(req.params.id, req.body, req))));

module.exports = router;