/**
 * Student routes for the review-meeting workflow. Mount at '/student', same
 * base as routes/student.js, same requireStudent guard. Every query is
 * scoped by the authenticated student's own id — never by a client-supplied
 * id — so one student can never see or touch another's meeting.
 */
import express from 'express';
import { requireStudent } from '../middleware/authMiddleware.js';
import * as M from '../service/meetingService.js';
import * as Q from '../service/meetingQueries.js';
import notificationService from '../service/notificationService.js';

const router = express.Router();
router.use(requireStudent);

router.get('/meetings', async (req, res) => {
  try {
    const view = req.query.view === 'past' ? 'past' : 'upcoming';
    const meetings = await Q.studentMeetings(req.user.id, view);
    res.render('student/meetings', { title: 'My Startup Meetings', meetings, view });
  } catch (err) { console.error(err); req.flash('error', 'Could not load your meetings.'); res.redirect('/student/dashboard'); }
});

router.get('/meetings/:id(\\d+)', async (req, res) => {
  try {
    const meeting = await Q.getMeetingForStudent(req.params.id, req.user.id);
    if (!meeting) { req.flash('error', 'Meeting not found.'); return res.redirect('/student/meetings'); }
    res.render('student/meeting-detail', { title: `Meeting — ${meeting.startup_title}`, meeting });
  } catch (err) { console.error(err); req.flash('error', 'Could not load this meeting.'); res.redirect('/student/meetings'); }
});

router.post('/meetings/:id(\\d+)/request-reschedule', async (req, res) => {
  const back = `/student/meetings/${req.params.id}`;
  try {
    await M.requestReschedule(req.user, req.params.id, req.body.reason);
    // Look up the request we just created so the admin email/notification has its id.
    const meeting = await Q.getMeetingForStudent(req.params.id, req.user.id);
    if (meeting?.pendingRequest) await notificationService.rescheduleRequested(meeting.pendingRequest.id);
    req.flash('success', 'Reschedule request sent. The incubation cell will get back to you.');
    res.redirect(back);
  } catch (e) {
    if (e instanceof M.MeetingError) req.flash('error', e.message);
    else { console.error('request-reschedule:', e); req.flash('error', 'Could not submit your request.'); }
    res.redirect(back);
  }
});

export default router;
