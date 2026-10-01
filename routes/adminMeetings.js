/**
 * Admin routes for the startup review & meeting scheduling workflow.
 * Mount at '/admin' — same base as routes/admin.js, same requireAdmin guard.
 * All business rules live in service/meetingService.js; routes stay thin,
 * exactly like routes/adminResources.js does for the resource module.
 */
import express from 'express';
import db from '../config/db.js';
import { requireAdmin } from '../middleware/authMiddleware.js';
import { audit } from '../service/auditService.js';
import notificationService from '../service/notificationService.js';
import * as M from '../service/meetingService.js';
import * as Q from '../service/meetingQueries.js';

const router = express.Router();
router.use(requireAdmin);

function fail(req, res, err, back) {
  if (err instanceof M.MeetingError) req.flash('error', err.message);
  else { console.error('Meeting route error:', err); req.flash('error', 'Something went wrong. Please try again.'); }
  return res.redirect(back);
}

/* ── list ─────────────────────────────────────────────────────────────────── */
router.get('/meetings', async (req, res) => {
  try {
    const view = ['upcoming', 'today', 'requested', 'completed', 'cancelled', 'all'].includes(req.query.view) ? req.query.view : 'upcoming';
    const { rows, counts } = await Q.listAdminMeetings(view);
    res.render('admin/meetings', { title: 'Startup Review Meetings', meetings: rows, counts, view });
  } catch (err) { console.error(err); req.flash('error', 'Could not load meetings.'); res.redirect('/admin/dashboard'); }
});

/* ── detail ───────────────────────────────────────────────────────────────── */
router.get('/meetings/:id(\\d+)', async (req, res) => {
  try {
    const meeting = await Q.getMeeting(req.params.id);
    if (!meeting) { req.flash('error', 'Meeting not found.'); return res.redirect('/admin/meetings'); }
    const history = await M.getHistory(meeting.startup_id);
    res.render('admin/meeting-detail', { title: `Meeting — ${meeting.startup_title}`, meeting, history });
  } catch (err) { console.error(err); req.flash('error', 'Could not load meeting.'); res.redirect('/admin/meetings'); }
});

/* ── schedule (from the startup detail page) ─────────────────────────────── */
router.post('/startups/:id(\\d+)/meeting', async (req, res) => {
  const back = `/admin/startup/${req.params.id}`;
  try {
    const meetingId = await M.scheduleMeeting(req.user, req.params.id, req.body);
    await notificationService.meetingScheduled(meetingId);
    req.flash('success', 'Meeting scheduled and the student has been notified.');
    res.redirect(back);
  } catch (e) { fail(req, res, e, back); }
});

router.post('/startups/:id(\\d+)/start-review', async (req, res) => {
  try { await M.markUnderReview(req.user, req.params.id); }
  catch (e) { /* non-critical — never block navigation on this */ console.error('start-review:', e.message); }
  res.redirect(`/admin/startup/${req.params.id}`);
});

/* ── request changes (distinct from the existing approve/reject status route) ── */
router.post('/startups/:id(\\d+)/request-changes', async (req, res) => {
  const back = `/admin/startup/${req.params.id}`;
  const remarks = String(req.body.requested_changes || '').trim();
  if (!remarks) { req.flash('error', 'Please describe what the student needs to provide.'); return res.redirect(back); }
  try {
    const result = await db.query(
      `UPDATE startups SET status='changes_requested', admin_remark=$2, updated_at=NOW()
       WHERE id=$1 AND is_deleted=false AND status NOT IN ('approved','rejected') RETURNING id`,
      [req.params.id, remarks]);
    if (!result.rows[0]) { req.flash('error', 'This startup already has a final decision and cannot be sent back for changes.'); return res.redirect(back); }
    await audit(req, 'STARTUP_CHANGES_REQUESTED', 'startup', Number(req.params.id), { details: { remarks } });
    await notificationService.changesRequested(req.params.id);
    req.flash('success', 'Changes requested — the student has been notified.');
    res.redirect(back);
  } catch (err) { console.error('request-changes:', err); req.flash('error', 'Failed to request changes.'); res.redirect(back); }
});

/* ── reschedule / cancel / complete / no-show ────────────────────────────── */
router.post('/meetings/:id(\\d+)/reschedule', async (req, res) => {
  const back = `/admin/meetings/${req.params.id}`;
  try {
    await M.rescheduleMeeting(req.user, req.params.id, req.body);
    await notificationService.meetingRescheduled(req.params.id);
    req.flash('success', 'Meeting rescheduled and the student has been notified.');
    res.redirect(back);
  } catch (e) { fail(req, res, e, back); }
});

router.post('/meetings/:id(\\d+)/cancel', async (req, res) => {
  const back = `/admin/meetings/${req.params.id}`;
  try {
    await M.cancelMeeting(req.user, req.params.id, req.body.reason);
    await notificationService.meetingCancelled(req.params.id);
    req.flash('success', 'Meeting cancelled.');
    res.redirect('/admin/meetings');
  } catch (e) { fail(req, res, e, back); }
});

router.post('/meetings/:id(\\d+)/complete', async (req, res) => {
  const back = `/admin/meetings/${req.params.id}`;
  try {
    await M.completeMeeting(req.user, req.params.id, req.body);
    await notificationService.meetingCompleted(req.params.id);
    req.flash('success', 'Meeting marked completed and outcome recorded.');
    res.redirect(back);
  } catch (e) { fail(req, res, e, back); }
});

router.post('/meetings/:id(\\d+)/no-show', async (req, res) => {
  const back = `/admin/meetings/${req.params.id}`;
  try {
    await M.markNoShow(req.user, req.params.id, req.body.notes);
    req.flash('success', 'Meeting marked as a no-show.');
    res.redirect(back);
  } catch (e) { fail(req, res, e, back); }
});

/* ── reschedule requests ──────────────────────────────────────────────────── */
router.post('/meetings/:id(\\d+)/reschedule-requests/:reqId(\\d+)/reject', async (req, res) => {
  const back = `/admin/meetings/${req.params.id}`;
  try {
    await M.rejectRescheduleRequest(req.user, req.params.reqId, req.body.admin_remarks);
    await notificationService.rescheduleRejected(req.params.reqId);
    req.flash('success', 'Reschedule request declined. The original time stands.');
    res.redirect(back);
  } catch (e) { fail(req, res, e, back); }
});

export default router;
