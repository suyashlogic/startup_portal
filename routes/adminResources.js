/**
 * Admin resource management. Mounted at /admin/resources (see index.js).
 * Thin handlers: validation and rules live in service/resourceService.js.
 * Notifications are added after commit in a later step; audit() is called here.
 */
import express from 'express';
import db from '../config/db.js';
import { requireAdmin } from '../middleware/authMiddleware.js';
import { audit } from '../service/auditService.js';
import * as S from '../service/resourceService.js';
import * as Q from '../service/resourceQueries.js';
import { uploadIssueAttachment } from '../middleware/upload.js';
import fs from 'fs/promises';

const router = express.Router();
router.use(requireAdmin);

const label = (s) => (s ? String(s).charAt(0) + String(s).slice(1).toLowerCase().replace(/_/g, ' ') : '');
const helpers = {
  label,
  date: (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'),
  dt:   (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'),
  inr:  (n) => (n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN')),
  badge: (s) => `<span class="badge rs-${String(s).toLowerCase()}">${label(s)}</span>`,
};
const STATUSES = ['AVAILABLE', 'RESERVED', 'ISSUED', 'IN_USE', 'MAINTENANCE', 'DAMAGED', 'RETIRED', 'UNAVAILABLE'];
const TYPES = ['ISSUABLE', 'BOOKABLE', 'CONSUMABLE', 'FACILITY'];
const CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'MINOR_DAMAGE', 'MAJOR_DAMAGE', 'UNUSABLE'];

router.use((req, res, next) => {
  res.locals.h = helpers;
  res.locals.enums = { STATUSES, TYPES, CONDITIONS };
  next();
});

/** Flash a user-safe message. Only ResourceError text is shown; anything else is logged, never leaked. */
function fail(req, res, err, back) {
  if (err instanceof S.ResourceError) req.flash('error', err.message);
  else { console.error('Resource route error:', err); req.flash('error', 'Something went wrong. Please try again.'); }
  return res.redirect(back);
}
const idOk = (v) => /^\d+$/.test(String(v));

/* ── Overview ─────────────────────────────────────────────────────────── */
router.get('/overview', async (req, res) => {
  try {
    await S.markOverdue();
    const days = parseInt(process.env.RESOURCE_WARRANTY_ALERT_DAYS, 10) || 30;
    res.render('admin/resources/overview', { title: 'Resource Management', o: await Q.overview(days), warrantyDays: days });
  } catch (err) { console.error(err); req.flash('error', 'Could not load resource overview.'); res.redirect('/admin/dashboard'); }
});

/* ── Categories ───────────────────────────────────────────────────────── */
router.get('/categories', async (req, res) => {
  try { res.render('admin/resources/categories', { title: 'Resource Categories', categories: await Q.categories() }); }
  catch (err) { console.error(err); req.flash('error', 'Could not load categories.'); res.redirect('/admin/resources'); }
});

router.post('/categories', async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 80) { req.flash('error', 'Category name is required (max 80 characters).'); return res.redirect('/admin/resources/categories'); }
  try {
    const r = await db.query(`INSERT INTO resource_categories (name, description) VALUES ($1,$2) RETURNING id`, [name, req.body.description || null]);
    await audit(req, 'RESOURCE_CATEGORY_CREATED', 'category', r.rows[0].id);
    req.flash('success', 'Category added.');
  } catch (err) {
    req.flash('error', err.code === '23505' ? 'A category with that name already exists.' : 'Could not add category.');
    if (err.code !== '23505') console.error(err);
  }
  res.redirect('/admin/resources/categories');
});

router.post('/categories/:id(\\d+)', async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) { req.flash('error', 'Category name is required.'); return res.redirect('/admin/resources/categories'); }
  try {
    const r = await db.query(`UPDATE resource_categories SET name=$2, description=$3, is_active=$4 WHERE id=$1 RETURNING id`,
                             [req.params.id, name, req.body.description || null, req.body.is_active === 'on']);
    if (!r.rows[0]) req.flash('error', 'Category not found.');
    else { await audit(req, 'RESOURCE_CATEGORY_UPDATED', 'category', r.rows[0].id); req.flash('success', 'Category updated.'); }
  } catch (err) {
    req.flash('error', err.code === '23505' ? 'A category with that name already exists.' : 'Could not update category.');
    if (err.code !== '23505') console.error(err);
  }
  res.redirect('/admin/resources/categories');
});

/* ── Requests ─────────────────────────────────────────────────────────── */
router.get('/requests', async (req, res) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const { rows, counts } = await Q.listRequests(status);
    res.render('admin/resources/requests', { title: 'Resource Requests', requests: rows, counts, status });
  } catch (err) { console.error(err); req.flash('error', 'Could not load requests.'); res.redirect('/admin/resources/overview'); }
});

const REQ = '/admin/resources/requests';
router.post('/requests/:id(\\d+)/approve', async (req, res) => {
  try { await S.approveRequest(req.user, req.params.id, req.body.admin_remarks);
        await audit(req, 'RESOURCE_REQUEST_APPROVED', 'resource_request', +req.params.id);
        req.flash('success', 'Request approved. You can now issue the resource.'); res.redirect(`${REQ}?status=APPROVED`); }
  catch (e) { fail(req, res, e, REQ); }
});
router.post('/requests/:id(\\d+)/reject', async (req, res) => {
  try { await S.rejectRequest(req.user, req.params.id, req.body.admin_remarks);
        await audit(req, 'RESOURCE_REQUEST_REJECTED', 'resource_request', +req.params.id);
        req.flash('success', 'Request rejected.'); res.redirect(REQ); }
  catch (e) { fail(req, res, e, REQ); }
});
router.post('/requests/:id(\\d+)/cancel', async (req, res) => {
  try { await S.cancelRequest(req.user, req.params.id, req.body.admin_remarks);
        await audit(req, 'RESOURCE_REQUEST_CANCELLED', 'resource_request', +req.params.id);
        req.flash('success', 'Request cancelled.'); res.redirect(REQ); }
  catch (e) { fail(req, res, e, REQ); }
});
router.post('/requests/:id(\\d+)/issue', async (req, res) => {
  try { const aid = await S.issueResource(req.user, req.params.id, req.body);
        await audit(req, 'RESOURCE_ISSUED', 'resource_assignment', aid, { details: { requestId: +req.params.id } });
        req.flash('success', 'Resource issued.'); res.redirect('/admin/resources/assignments'); }
  catch (e) { fail(req, res, e, `${REQ}?status=APPROVED`); }
});

/* ── Assignments / returns ────────────────────────────────────────────── */
router.get('/assignments', async (req, res) => {
  try {
    await S.markOverdue();
    const view = ['open', 'overdue', 'returned', 'all'].includes(req.query.view) ? req.query.view : 'open';
    res.render('admin/resources/assignments', { title: 'Resource Assignments', assignments: await Q.listAssignments(view), view });
  } catch (err) { console.error(err); req.flash('error', 'Could not load assignments.'); res.redirect('/admin/resources/overview'); }
});
router.post('/assignments/:id(\\d+)/return', async (req, res) => {
  try {
    const out = await S.completeReturn(req.user, req.params.id, req.body);
    await audit(req, 'RESOURCE_RETURNED', 'resource_assignment', +req.params.id, { details: { condition: req.body.return_condition } });
    req.flash('success', out.needsMaintenance ? 'Return recorded. The item is marked damaged and needs maintenance.' : 'Return completed.');
    res.redirect('/admin/resources/assignments');
  } catch (e) { fail(req, res, e, '/admin/resources/assignments'); }
});

/* ── Bookings ─────────────────────────────────────────────────────────── */
router.get('/bookings', async (req, res) => {
  try {
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const { rows, counts } = await Q.listBookings(status);
    res.render('admin/resources/bookings', { title: 'Resource Bookings', bookings: rows, counts, status });
  } catch (err) { console.error(err); req.flash('error', 'Could not load bookings.'); res.redirect('/admin/resources/overview'); }
});

const BK = '/admin/resources/bookings';
router.post('/bookings/:id(\\d+)/approve', async (req, res) => {
  try { await S.approveBooking(req.user, req.params.id);
        await audit(req, 'RESOURCE_BOOKING_APPROVED', 'resource_booking', +req.params.id);
        req.flash('success', 'Booking approved.'); res.redirect(`${BK}?status=APPROVED`); }
  catch (e) { fail(req, res, e, BK); }
});
router.post('/bookings/:id(\\d+)/reject', async (req, res) => {
  try { await S.rejectBooking(req.user, req.params.id, req.body.admin_remarks);
        await audit(req, 'RESOURCE_BOOKING_REJECTED', 'resource_booking', +req.params.id);
        req.flash('success', 'Booking rejected.'); res.redirect(BK); }
  catch (e) { fail(req, res, e, BK); }
});

/* ── Issues ───────────────────────────────────────────────────────────── */
router.get('/issues', async (req, res) => {
  try {
    const status = String(req.query.status || 'OPEN').toUpperCase();
    const { rows, counts } = await Q.listIssues(status);
    res.render('admin/resources/issues', { title: 'Resource Issues', issues: rows, counts, status });
  } catch (err) { console.error(err); req.flash('error', 'Could not load issues.'); res.redirect('/admin/resources/overview'); }
});

const ISS = '/admin/resources/issues';
router.post('/issues/:id(\\d+)/inspect', async (req, res) => {
  try { await S.setIssueUnderInspection(req.user, req.params.id);
        await audit(req, 'RESOURCE_ISSUE_INSPECTING', 'resource_issue', +req.params.id);
        req.flash('success', 'Marked under inspection.'); res.redirect(`${ISS}?status=UNDER_INSPECTION`); }
  catch (e) { fail(req, res, e, ISS); }
});
router.post('/issues/:id(\\d+)/resolve', async (req, res) => {
  try { await S.resolveIssue(req.user, req.params.id, req.body);
        await audit(req, 'RESOURCE_ISSUE_RESOLVED', 'resource_issue', +req.params.id);
        req.flash('success', 'Issue resolved.'); res.redirect(ISS); }
  catch (e) { fail(req, res, e, ISS); }
});
router.post('/issues/:id(\\d+)/start-maintenance', async (req, res) => {
  try {
    const resourceId = req.body.resource_id;
    const mid = await S.startMaintenance(req.user, resourceId, { ...req.body, issue_id: req.params.id });
    await audit(req, 'RESOURCE_MAINTENANCE_STARTED', 'resource_maintenance', mid, { details: { issueId: +req.params.id } });
    req.flash('success', 'Maintenance started for this issue.');
    res.redirect('/admin/resources/maintenance');
  } catch (e) { fail(req, res, e, ISS); }
});

/* ── Maintenance ──────────────────────────────────────────────────────── */
router.get('/maintenance', async (req, res) => {
  try {
    const view = ['open', 'completed', 'cancelled', 'all'].includes(req.query.view) ? req.query.view : 'open';
    const [{ rows, counts }, resources] = await Promise.all([
      Q.listMaintenance(view),
      db.query(`SELECT id, name, asset_code, status, quantity FROM resources WHERE is_active AND status IN ('AVAILABLE','DAMAGED') ORDER BY name`)
    ]);
    res.render('admin/resources/maintenance', { title: 'Maintenance', maintenance: rows, counts, view, resources: resources.rows });
  } catch (err) { console.error(err); req.flash('error', 'Could not load maintenance.'); res.redirect('/admin/resources/overview'); }
});

const MNT = '/admin/resources/maintenance';
router.post('/maintenance', async (req, res) => {
  try {
    await S.startMaintenance(req.user, req.body.resource_id, req.body);
    await audit(req, 'RESOURCE_MAINTENANCE_STARTED', 'resource', +req.body.resource_id);
    req.flash('success', 'Maintenance scheduled.'); res.redirect(MNT);
  } catch (e) { fail(req, res, e, MNT); }
});
router.post('/maintenance/:id(\\d+)/complete', async (req, res) => {
  try {
    const out = await S.completeMaintenance(req.user, req.params.id, req.body);
    await audit(req, 'RESOURCE_MAINTENANCE_COMPLETED', 'resource_maintenance', +req.params.id, { details: { cost: req.body.cost } });
    req.flash('success', 'Maintenance completed. Resource is available again.');
    res.redirect(MNT);
  } catch (e) { fail(req, res, e, MNT); }
});
router.post('/maintenance/:id(\\d+)/cancel', async (req, res) => {
  try { await S.cancelMaintenance(req.user, req.params.id, req.body.reason);
        await audit(req, 'RESOURCE_MAINTENANCE_CANCELLED', 'resource_maintenance', +req.params.id);
        req.flash('success', 'Maintenance cancelled.'); res.redirect(MNT); }
  catch (e) { fail(req, res, e, MNT); }
});

/* ── Resource CRUD ────────────────────────────────────────────────────── */
router.get('/', async (req, res) => {
  try {
    const filters = Object.fromEntries(['q', 'category', 'status', 'type', 'condition', 'location', 'sort', 'inactive'].map((k) => [k, String(req.query[k] || '')]));
    const [result, cats] = await Promise.all([Q.listResources({ ...filters, page: req.query.page }), Q.categories()]);
    res.render('admin/resources/index', { title: 'All Resources', ...result, filters, categories: cats });
  } catch (err) { console.error(err); req.flash('error', 'Could not load resources.'); res.redirect('/admin/resources/overview'); }
});

router.get('/new', async (req, res) => {
  res.render('admin/resources/form', { title: 'Add Resource', resource: null, values: {}, categories: await Q.categories(true), formError: null });
});

router.post('/', async (req, res) => {
  try {
    const r = await S.createResource(req.user, req.body);
    await audit(req, 'RESOURCE_CREATED', 'resource', r.id, { details: { assetCode: r.asset_code } });
    req.flash('success', `Resource added as ${r.asset_code}.`);
    res.redirect(`/admin/resources/${r.id}`);
  } catch (e) {
    if (!(e instanceof S.ResourceError)) console.error(e);
    res.status(400).render('admin/resources/form', { title: 'Add Resource', resource: null, values: req.body, categories: await Q.categories(true),
      formError: e instanceof S.ResourceError ? e.message : 'Could not save the resource.' });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const resource = await Q.getResource(req.params.id);
    if (!resource) { req.flash('error', 'Resource not found.'); return res.redirect('/admin/resources'); }
    const [extras, history] = await Promise.all([Q.resourceDetailExtras(resource.id), S.getHistory(resource.id)]);
    res.render('admin/resources/detail', { title: resource.name, resource, history, ...extras });
  } catch (err) { console.error(err); req.flash('error', 'Could not load resource.'); res.redirect('/admin/resources'); }
});

router.get('/:id(\\d+)/edit', async (req, res) => {
  const resource = await Q.getResource(req.params.id);
  if (!resource) { req.flash('error', 'Resource not found.'); return res.redirect('/admin/resources'); }
  res.render('admin/resources/form', { title: `Edit ${resource.asset_code}`, resource, values: resource, categories: await Q.categories(true), formError: null });
});

router.post('/:id(\\d+)/edit', async (req, res) => {
  try {
    const code = await S.updateResource(req.user, req.params.id, req.body);
    await audit(req, 'RESOURCE_UPDATED', 'resource', +req.params.id);
    req.flash('success', `${code} updated.`);
    res.redirect(`/admin/resources/${req.params.id}`);
  } catch (e) {
    if (!(e instanceof S.ResourceError)) console.error(e);
    const resource = await Q.getResource(req.params.id);
    if (!resource) return res.redirect('/admin/resources');
    res.status(400).render('admin/resources/form', { title: `Edit ${resource.asset_code}`, resource, values: { ...resource, ...req.body },
      categories: await Q.categories(true), formError: e instanceof S.ResourceError ? e.message : 'Could not save changes.' });
  }
});

router.post('/:id(\\d+)/deactivate', async (req, res) => {
  try {
    const code = await S.deactivateResource(req.user, req.params.id);
    await audit(req, 'RESOURCE_DEACTIVATED', 'resource', +req.params.id);
    req.flash('success', `${code} deactivated. Its history is preserved.`);
    res.redirect('/admin/resources');
  } catch (e) { fail(req, res, e, `/admin/resources/${req.params.id}`); }
});

export default router;
