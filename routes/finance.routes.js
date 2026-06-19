const express = require('express');
const mongoose = require('mongoose');

const FinanceRecord = require('../models/FinanceRecord');
const { requireAuth, requireModuleAccess, requireSpecialRight } = require('../middleware/requireAuth');
const { logAudit } = require('../lib/audit');

const router = express.Router();

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, success: true, status, ...data });
}

function bad(res, status, message, code) {
  return res.status(status).json({ ok: false, success: false, status, code: code || undefined, message });
}

function actorId(req) {
  return mongoose.isValidObjectId(req.user?.id) ? req.user.id : null;
}

function parseDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function recordDto(record) {
  if (!record) return null;
  const id = record._id ? String(record._id) : (record.id ? String(record.id) : null);
  return {
    ...(id ? { _id: id, id } : {}),
    type: record.type,
    title: record.title || '',
    amount: typeof record.amount === 'number' ? record.amount : 0,
    currency: record.currency || 'INR',
    status: record.status || 'draft',
    sponsorName: record.sponsorName || '',
    invoiceNumber: record.invoiceNumber || '',
    receiptUrl: record.receiptUrl || '',
    period: record.period || '',
    dueDate: record.dueDate || null,
    paidAt: record.paidAt || null,
    notes: record.notes || '',
    metadata: record.metadata || null,
    createdBy: record.createdBy || null,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
  };
}

function recordPayload(req, type) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const amount = body.amount === undefined ? 0 : Number(body.amount);
  return {
    type,
    title: String(body.title || body.name || '').trim(),
    amount: Number.isFinite(amount) ? amount : 0,
    currency: String(body.currency || 'INR').trim().toUpperCase(),
    status: String(body.status || 'draft').trim().toLowerCase(),
    sponsorName: String(body.sponsorName || body.sponsor || '').trim(),
    invoiceNumber: String(body.invoiceNumber || '').trim(),
    receiptUrl: String(body.receiptUrl || body.url || '').trim(),
    period: String(body.period || '').trim(),
    dueDate: parseDate(body.dueDate),
    paidAt: parseDate(body.paidAt),
    notes: String(body.notes || '').trim(),
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : null,
    createdBy: actorId(req),
    updatedBy: actorId(req),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function ensureDb(res) {
  if (isDbReady()) return true;
  bad(res, 503, 'Database unavailable', 'DB_UNAVAILABLE');
  return false;
}

async function listByType(req, res, type, key) {
  if (!(await ensureDb(res))) return;
  const docs = await FinanceRecord.find({ type }).sort({ createdAt: -1 }).limit(200).lean();
  const records = (docs || []).map(recordDto);
  return ok(res, { data: { [key]: records }, [key]: records });
}

async function createRecord(req, res, type, auditAction) {
  if (!(await ensureDb(res))) return;
  const created = await FinanceRecord.create(recordPayload(req, type));
  await logAudit(req, auditAction, String(created._id), recordDto(created));
  return ok(res, { data: { record: recordDto(created) }, record: recordDto(created) }, 201);
}

router.use(requireAuth, requireModuleAccess('finance_desk'));

router.get('/summary', requireSpecialRight('finance_view'), async (_req, res) => {
  if (!(await ensureDb(res))) return;
  const docs = await FinanceRecord.find({}).sort({ createdAt: -1 }).limit(500).lean();
  const summary = {
    invoiceCount: 0,
    expenseCount: 0,
    receiptCount: 0,
    revenueTotal: 0,
    expenseTotal: 0,
    invoiceTotal: 0,
  };
  for (const doc of docs || []) {
    const amount = typeof doc.amount === 'number' ? doc.amount : 0;
    if (doc.type === 'invoice') {
      summary.invoiceCount += 1;
      summary.invoiceTotal += amount;
    }
    if (doc.type === 'expense') {
      summary.expenseCount += 1;
      summary.expenseTotal += amount;
    }
    if (doc.type === 'receipt') summary.receiptCount += 1;
    if (doc.type === 'revenue') summary.revenueTotal += amount;
  }
  return ok(res, { data: { summary }, summary });
});

router.post('/invoices', requireSpecialRight('finance_create_invoice'), (req, res) => createRecord(req, res, 'invoice', 'FINANCE_RECORD_CREATE'));
router.get('/invoices', requireSpecialRight('finance_view'), (req, res) => listByType(req, res, 'invoice', 'invoices'));

router.patch('/invoices/:id', requireSpecialRight('finance_update_invoice_status'), async (req, res) => {
  if (!(await ensureDb(res))) return;
  if (!mongoose.isValidObjectId(String(req.params.id))) return bad(res, 400, 'Invalid id', 'INVALID_ID');
  const patch = recordPayload(req, 'invoice');
  delete patch.createdBy;
  delete patch.createdAt;
  const updated = await FinanceRecord.findOneAndUpdate({ _id: req.params.id, type: 'invoice' }, { $set: patch }, { new: true });
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'FINANCE_RECORD_UPDATE', String(updated._id), recordDto(updated));
  return ok(res, { data: { record: recordDto(updated) }, record: recordDto(updated) });
});

router.post('/expenses', requireSpecialRight('finance_add_expense_entry'), (req, res) => createRecord(req, res, 'expense', 'FINANCE_RECORD_CREATE'));
router.get('/expenses', requireSpecialRight('finance_view'), (req, res) => listByType(req, res, 'expense', 'expenses'));
router.post('/receipts', requireSpecialRight('finance_upload_receipt'), (req, res) => createRecord(req, res, 'receipt', 'FINANCE_RECORD_CREATE'));

router.get('/monthly-report', requireSpecialRight('finance_prepare_monthly_report'), async (req, res) => {
  if (!(await ensureDb(res))) return;
  const period = String(req.query.period || '').trim();
  const filter = period ? { period } : {};
  const docs = await FinanceRecord.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  const records = (docs || []).map(recordDto);
  await logAudit(req, 'FINANCE_RECORD_UPDATE', null, { action: 'monthly_report_prepared', period: period || null });
  return ok(res, { data: { period: period || null, records }, period: period || null, records });
});

module.exports = router;