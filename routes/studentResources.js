/**
 * Student resource routes. Mounted at /student/resources and /student/my-resources
 * (see index.js — two mount points because "my resources" reads more naturally
 * outside the /resources/:id namespace, matching the existing /student/startups split).
 */
import express from 'express';
import { requireStudent } from '../middleware/authMiddleware.js';
import * as S from '../service/resourceService.js';
import * as Q from '../service/resourceQueries.js';
import { uploadIssueAttachment } from '../middleware/upload.js';
import fs from 'fs/promises';
const discardUpload = (req) => (req.file ? fs.unlink(req.file.path).catch(() => {}) : Promise.resolve());

const router = express.Router();
router.use(requireStudent);

const label = (s) => (s ? String(s).charAt(0) + String(s).slice(1).toLowerCase().replace(/_/g, ' ') : '');
const helpers = {
  label,
  date: (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'),
  dt:   (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'),
  time: (t) => (t ? String(t).slice(0, 5) : ''),
  badge: (s) => `<span class="badge rs-${String(s).toLowerCase()}">${label(s)}</span>`,
};
router.use((req, res, next) => { res.locals.h = helpers; next(); });

function fail(req, res, err, back) {
  if (err instanceof S.ResourceError) req.flash('error', err.message);
  else { console.error('Student resource route error:', err); req.flash('error', 'Something went wrong. Please try again.'); }
  return res.redirect(back);
}

/* ── Browse ───────────────────────────────────────────────────────────── */
router.get('/resources', async (req, res) => {
  try {
    const f = { q: req.query.q || '', category: req.query.category || '', type: req.query.type || '' };
    const [rows, categories] = await Promise.all([Q.browseResources(f), Q.categories(true)]);
    res.render('student/resources/index', { title: 'Browse Resources', resources: rows, categories, filters: f });
  } catch (err) { console.error(err); req.flash('error', 'Could not load resources.'); res.redirect('/student/dashboard'); }
});

router.get('/resources/:id(\\d+)', async (req, res) => {
  try {
    const resource = await Q.getResourceForStudent(req.params.id);
    if (!resource) { req.flash('error', 'Resource not found.'); return res.redirect('/student/resources'); }
    const startups = await Q.myStartups(req.user.id);
    const availability = resource.resource_type === 'BOOKABLE' || resource.resource_type === 'FACILITY'
      ? await S.dayAvailability(resource.id, req.query.date) : null;
    res.render('student/resources/detail', { title: resource.name, resource, startups, availability, formError: null });
  } catch (err) { console.error(err); req.flash('error', 'Could not load resource.'); res.redirect('/student/resources'); }
});

router.get('/resources/:id(\\d+)/availability', async (req, res) => {   // small JSON endpoint the date-picker calls
  try { res.json(await S.dayAvailability(req.params.id, req.query.date)); }
  catch (err) { res.status(400).json({ error: 'Could not load availability.' }); }
});

router.post('/resources/:id(\\d+)/request', async (req, res) => {
  try {
    await S.requestResource(req.user, req.params.id, req.body);
    req.flash('success', 'Request submitted. You will be notified once it is reviewed.');
    res.redirect('/student/my-resources');
  } catch (e) { fail(req, res, e, `/student/resources/${req.params.id}`); }
});

router.post('/resources/:id(\\d+)/book', async (req, res) => {
  try {
    await S.createBooking(req.user, req.params.id, req.body);
    req.flash('success', 'Booking submitted. You will be notified once it is reviewed.');
    res.redirect('/student/my-bookings');
  } catch (e) { fail(req, res, e, `/student/resources/${req.params.id}`); }
});

router.get('/report-issue', async (req, res) => {
  try {
    const [current, resource] = await Promise.all([
      Q.myAssignments(req.user.id, 'current'),
      req.query.resource_id ? Q.getResourceForStudent(req.query.resource_id) : null
    ]);
    res.render('student/resources/report-issue', { title: 'Report an Issue', current, resource: resource || null, formError: null });
  } catch (err) { console.error(err); req.flash('error', 'Could not load this page.'); res.redirect('/student/dashboard'); }
});

router.post('/resources/:id(\\d+)/report-issue', (req, res, next) => {
  uploadIssueAttachment.single('attachment')(req, res, (err) => {
    if (err) { req.flash('error', err.message || 'Could not upload that file.'); return res.redirect(`/student/resources/${req.params.id}`); }
    next();
  });
}, async (req, res) => {
  try {
    const attachment = req.file ? '/uploads/' + req.file.filename : null;
    await S.reportIssue(req.user, req.params.id, { ...req.body, attachment });
    req.flash('success', 'Thanks — the incubation cell has been notified.');
    res.redirect('/student/my-resources');
  } catch (e) {
    await discardUpload(req);
    fail(req, res, e, req.get('Referer') && req.get('Referer').includes('report-issue') ? `/student/report-issue` : `/student/resources/${req.params.id}`);
  }
});

/* ── My requests / equipment ─────────────────────────────────────────── */
router.get('/my-resources', async (req, res) => {
  try {
    const [requests, current, history] = await Promise.all([
      Q.myRequests(req.user.id), Q.myAssignments(req.user.id, 'current'), Q.myAssignments(req.user.id, 'history')
    ]);
    res.render('student/resources/my-resources', { title: 'My Resources', requests, current, history });
  } catch (err) { console.error(err); req.flash('error', 'Could not load your resources.'); res.redirect('/student/dashboard'); }
});

router.post('/my-resources/requests/:id(\\d+)/cancel', async (req, res) => {
  try { await S.cancelOwnRequest(req.user, req.params.id); req.flash('success', 'Request withdrawn.'); }
  catch (e) { if (e instanceof S.ResourceError) req.flash('error', e.message); else { console.error(e); req.flash('error', 'Could not withdraw the request.'); } }
  res.redirect('/student/my-resources');
});

router.post('/my-resources/:id(\\d+)/return', async (req, res) => {
  try { await S.requestReturn(req.user, req.params.id); req.flash('success', 'Return requested. An admin will inspect it shortly.'); }
  catch (e) { if (e instanceof S.ResourceError) req.flash('error', e.message); else { console.error(e); req.flash('error', 'Could not request return.'); } }
  res.redirect('/student/my-resources');
});

/* ── My bookings ──────────────────────────────────────────────────────── */
router.get('/my-bookings', async (req, res) => {
  try {
    const view = req.query.view === 'past' ? 'past' : 'upcoming';
    res.render('student/resources/my-bookings', { title: 'My Bookings', bookings: await Q.myBookings(req.user.id, view), view });
  } catch (err) { console.error(err); req.flash('error', 'Could not load your bookings.'); res.redirect('/student/dashboard'); }
});

router.post('/my-bookings/:id(\\d+)/cancel', async (req, res) => {
  try { await S.cancelBooking(req.user, req.params.id); req.flash('success', 'Booking cancelled.'); }
  catch (e) { if (e instanceof S.ResourceError) req.flash('error', e.message); else { console.error(e); req.flash('error', 'Could not cancel the booking.'); } }
  res.redirect('/student/my-bookings');
});

export default router;
