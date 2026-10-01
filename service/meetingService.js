/**
 * meetingService: all startup-review-meeting business rules live here; routes
 * stay thin. Mirrors the shape of service/resourceService.js exactly —
 * withTransaction(), a locked row read first, a typed error class routes can
 * catch, and DB-level conflict prevention (an EXCLUDE constraint) rather than
 * a hand-rolled overlap check, so it holds even under concurrent requests.
 *
 * Notifications are NOT sent from here: every function returns the id(s) the
 * route needs, and the route calls notificationService AFTER commit — same
 * rule as every other service in this codebase, so a slow/failed email can
 * never roll back a real scheduling decision.
 */
import db, { withTransaction } from '../config/db.js';
import { audit } from './auditService.js';

export class MeetingError extends Error {
  constructor(message, code = 'INVALID') { super(message); this.code = code; }
}

const MEETING_TYPES = ['IN_PERSON', 'ONLINE', 'HYBRID'];
const RECOMMENDATIONS = ['APPROVE', 'REQUEST_CHANGES', 'FOLLOW_UP', 'REJECT'];
const CLOSED_STARTUP_STATUSES = ['approved', 'rejected'];

/* ── IST-aware date/time helpers ─────────────────────────────────────────── */
const TZ = () => process.env.APP_TIMEZONE || 'Asia/Kolkata';
function istNowParts() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const parseDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !isNaN(Date.parse(s)) ? String(s) : null);
const parseTime = (s) => (/^\d{2}:\d{2}$/.test(String(s)) ? String(s) : null);
function isInFuture(date, time) {
  const now = istNowParts();
  return date > now.date || (date === now.date && time > now.time);
}

/* ── validation shared by schedule + reschedule ──────────────────────────── */
function validateMeetingFields(f) {
  const date = parseDate(f.meeting_date);
  const start = parseTime(f.start_time);
  const end = parseTime(f.end_time);
  if (!date) throw new MeetingError('Please choose a valid meeting date.');
  if (!start || !end) throw new MeetingError('Please choose valid start and end times.');
  if (end <= start) throw new MeetingError('End time must be after start time.');
  if (!isInFuture(date, start)) throw new MeetingError('The meeting must be scheduled in the future (IST).');
  if (!MEETING_TYPES.includes(f.meeting_type)) throw new MeetingError('Select a valid meeting type.');
  const location = (f.location || '').trim() || null;
  const link = (f.meeting_link || '').trim() || null;
  if (f.meeting_type !== 'ONLINE' && !location) throw new MeetingError('Location is required for an in-person or hybrid meeting.');
  if (f.meeting_type !== 'IN_PERSON' && !link) throw new MeetingError('A meeting link is required for an online or hybrid meeting.');
  return {
    date, start, end, type: f.meeting_type, location, link,
    agenda: (f.agenda || '').trim() || null,
    notes: (f.notes || '').trim() || null,
    title: (f.title || '').trim() || 'Startup Review Meeting',
  };
}

async function lockStartup(c, id) {
  const r = await c.query(`SELECT * FROM startups WHERE id = $1 AND is_deleted = false FOR UPDATE`, [id]);
  if (!r.rows[0]) throw new MeetingError('Startup not found.', 'NOT_FOUND');
  return r.rows[0];
}

async function lockMeeting(c, id) {
  const r = await c.query(`SELECT * FROM startup_meetings WHERE id = $1 FOR UPDATE`, [id]);
  if (!r.rows[0]) throw new MeetingError('Meeting not found.', 'NOT_FOUND');
  return r.rows[0];
}

/* ── schedule ─────────────────────────────────────────────────────────────
 * Called with reviewer = the admin doing the scheduling. `reviewerId` lets an
 * admin schedule on behalf of another reviewer later without changing the
 * call shape; today the routes always pass the acting admin. */
export async function scheduleMeeting(admin, startupId, f, reviewerId = null) {
  const v = validateMeetingFields(f);
  try {
    return await withTransaction(async (c) => {
      const startup = await lockStartup(c, startupId);
      if (CLOSED_STARTUP_STATUSES.includes(startup.status)) {
        throw new MeetingError(`This startup has already been ${startup.status}. Reopen review before scheduling a meeting.`, 'STATE');
      }
      const m = (await c.query(
        `INSERT INTO startup_meetings
           (startup_id, reviewer_id, created_by, title, meeting_date, start_time, end_time,
            meeting_type, location, meeting_link, agenda, notes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'SCHEDULED')
         RETURNING id`,
        [startupId, reviewerId || admin.id, admin.id, v.title, v.date, v.start, v.end,
         v.type, v.location, v.link, v.agenda, v.notes])).rows[0];

      if (!['under_review', 'meeting_scheduled'].includes(startup.status)) {
        await c.query(`UPDATE startups SET status = 'meeting_scheduled', updated_at = NOW() WHERE id = $1`, [startupId]);
      } else if (startup.status !== 'meeting_scheduled') {
        await c.query(`UPDATE startups SET status = 'meeting_scheduled', updated_at = NOW() WHERE id = $1`, [startupId]);
      }
      await audit(admin ? { user: admin, ip: null } : {}, 'MEETING_SCHEDULED', 'startup_meeting', m.id, { details: { startupId } });
      return m.id;
    });
  } catch (e) {
    if (e.code === '23P01') throw new MeetingError('That reviewer (or this startup) already has a meeting overlapping this time.', 'CONFLICT');
    throw e;
  }
}

/** Admin reopens review on a startup that already has a decision, or simply marks it "being looked at". */
export async function markUnderReview(admin, startupId) {
  return withTransaction(async (c) => {
    const s = await lockStartup(c, startupId);
    if (s.status !== 'pending') return s.status;   // only the first open matters; never clobber further-along state
    await c.query(`UPDATE startups SET status = 'under_review', updated_at = NOW() WHERE id = $1`, [startupId]);
    await audit({ user: admin }, 'STARTUP_UNDER_REVIEW', 'startup', startupId);
    return 'under_review';
  });
}

/* ── reschedule (admin-initiated; also used to action an approved student request) ── */
export async function rescheduleMeeting(admin, meetingId, f) {
  const v = validateMeetingFields(f);
  try {
    return await withTransaction(async (c) => {
      const m = await lockMeeting(c, meetingId);
      if (!['SCHEDULED', 'CONFIRMED', 'RESCHEDULE_REQUESTED'].includes(m.status)) {
        throw new MeetingError(`This meeting is already ${m.status.toLowerCase().replace(/_/g, ' ')} and cannot be rescheduled.`, 'STATE');
      }
      await c.query(
        `UPDATE startup_meetings
         SET meeting_date=$2, start_time=$3, end_time=$4, meeting_type=$5, location=$6, meeting_link=$7,
             agenda=$8, notes=COALESCE($9, notes), status='SCHEDULED', reminder_24h_sent_at=NULL
         WHERE id=$1`,
        [meetingId, v.date, v.start, v.end, v.type, v.location, v.link, v.agenda, v.notes]);
      await c.query(
        `UPDATE meeting_reschedule_requests SET status='APPROVED', resolved_at=NOW()
         WHERE meeting_id=$1 AND status='PENDING'`, [meetingId]);
      await audit({ user: admin }, 'MEETING_RESCHEDULED', 'startup_meeting', meetingId, { details: { startupId: m.startup_id } });
      return m.startup_id;
    });
  } catch (e) {
    if (e.code === '23P01') throw new MeetingError('That reviewer (or this startup) already has a meeting overlapping the new time.', 'CONFLICT');
    throw e;
  }
}

/* ── cancel ───────────────────────────────────────────────────────────────── */
export async function cancelMeeting(admin, meetingId, reason) {
  if (!String(reason || '').trim()) throw new MeetingError('A cancellation reason is required.');
  return withTransaction(async (c) => {
    const m = await lockMeeting(c, meetingId);
    if (['COMPLETED', 'CANCELLED'].includes(m.status)) throw new MeetingError(`This meeting is already ${m.status.toLowerCase()}.`, 'STATE');
    await c.query(`UPDATE startup_meetings SET status='CANCELLED', cancel_reason=$2 WHERE id=$1`, [meetingId, reason.trim()]);
    await c.query(`UPDATE meeting_reschedule_requests SET status='REJECTED', resolved_at=NOW() WHERE meeting_id=$1 AND status='PENDING'`, [meetingId]);
    // Never silently strand the startup on "meeting_scheduled" with no live meeting.
    const stillLive = await c.query(
      `SELECT 1 FROM startup_meetings WHERE startup_id=$1 AND status IN ('SCHEDULED','CONFIRMED') AND id <> $2`, [m.startup_id, meetingId]);
    if (!stillLive.rows[0]) {
      await c.query(`UPDATE startups SET status='under_review', updated_at=NOW() WHERE id=$1 AND status='meeting_scheduled'`, [m.startup_id]);
    }
    await audit({ user: admin }, 'MEETING_CANCELLED', 'startup_meeting', meetingId, { details: { startupId: m.startup_id, reason: reason.trim() } });
    return m.startup_id;
  });
}

/* ── complete + record outcome ───────────────────────────────────────────── */
export async function completeMeeting(admin, meetingId, outcome) {
  if (outcome.recommendation && !RECOMMENDATIONS.includes(outcome.recommendation)) throw new MeetingError('Invalid recommendation.');
  const nextReview = outcome.next_review_date ? parseDate(outcome.next_review_date) : null;
  if (outcome.next_review_date && !nextReview) throw new MeetingError('Next review date is invalid.');

  return withTransaction(async (c) => {
    const m = await lockMeeting(c, meetingId);
    if (m.status === 'CANCELLED') throw new MeetingError('A cancelled meeting cannot be marked completed.', 'STATE');
    if (m.status === 'COMPLETED') throw new MeetingError('This meeting is already marked completed.', 'STATE');

    await c.query(`UPDATE startup_meetings SET status='COMPLETED' WHERE id=$1`, [meetingId]);
    await c.query(
      `INSERT INTO meeting_outcomes
         (meeting_id, founder_attended, team_attended, discussion_notes, strengths, concerns,
          action_items, recommendation, next_review_date, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (meeting_id) DO UPDATE SET
         founder_attended=EXCLUDED.founder_attended, team_attended=EXCLUDED.team_attended,
         discussion_notes=EXCLUDED.discussion_notes, strengths=EXCLUDED.strengths, concerns=EXCLUDED.concerns,
         action_items=EXCLUDED.action_items, recommendation=EXCLUDED.recommendation,
         next_review_date=EXCLUDED.next_review_date, recorded_by=EXCLUDED.recorded_by, recorded_at=NOW()`,
      [meetingId, !!outcome.founder_attended, !!outcome.team_attended, outcome.discussion_notes || null,
       outcome.strengths || null, outcome.concerns || null, outcome.action_items || null,
       outcome.recommendation || null, nextReview, admin.id]);

    await c.query(`UPDATE startups SET status='meeting_completed', updated_at=NOW() WHERE id=$1 AND status='meeting_scheduled'`, [m.startup_id]);
    await audit({ user: admin }, 'MEETING_COMPLETED', 'startup_meeting', meetingId,
                { details: { startupId: m.startup_id, recommendation: outcome.recommendation || null } });
    return m.startup_id;
  });
}

export async function markNoShow(admin, meetingId, notes) {
  return withTransaction(async (c) => {
    const m = await lockMeeting(c, meetingId);
    if (!['SCHEDULED', 'CONFIRMED'].includes(m.status)) throw new MeetingError('Only a scheduled meeting can be marked as a no-show.', 'STATE');
    await c.query(`UPDATE startup_meetings SET status='NO_SHOW', notes=COALESCE($2, notes) WHERE id=$1`, [meetingId, notes || null]);
    await audit({ user: admin }, 'MEETING_NO_SHOW', 'startup_meeting', meetingId, { details: { startupId: m.startup_id } });
    return m.startup_id;
  });
}

/* ── student: request a reschedule (never changes the meeting directly) ───── */
export async function requestReschedule(student, meetingId, reason) {
  if (!String(reason || '').trim()) throw new MeetingError('Please explain why you need a different time.');
  return withTransaction(async (c) => {
    const m = (await c.query(
      `SELECT sm.* FROM startup_meetings sm JOIN startups s ON s.id = sm.startup_id
       WHERE sm.id = $1 AND s.student_id = $2 FOR UPDATE`, [meetingId, student.id])).rows[0];
    if (!m) throw new MeetingError('Meeting not found.', 'NOT_FOUND');
    if (!['SCHEDULED', 'CONFIRMED'].includes(m.status)) throw new MeetingError('This meeting can no longer be rescheduled.', 'STATE');
    try {
      await c.query(
        `INSERT INTO meeting_reschedule_requests (meeting_id, requested_by, reason) VALUES ($1,$2,$3)`,
        [meetingId, student.id, reason.trim()]);
    } catch (e) {
      if (e.code === '23505') throw new MeetingError('You already have a pending reschedule request for this meeting.', 'DUPLICATE');
      throw e;
    }
    await c.query(`UPDATE startup_meetings SET status='RESCHEDULE_REQUESTED' WHERE id=$1`, [meetingId]);
    await audit({ user: student }, 'MEETING_RESCHEDULE_REQUESTED', 'startup_meeting', meetingId, { details: { startupId: m.startup_id } });
    return m.startup_id;
  });
}

/** Admin rejects a reschedule request outright, leaving the original time in place. */
export async function rejectRescheduleRequest(admin, requestId, adminRemarks) {
  return withTransaction(async (c) => {
    const req = (await c.query(`SELECT * FROM meeting_reschedule_requests WHERE id=$1 FOR UPDATE`, [requestId])).rows[0];
    if (!req) throw new MeetingError('Request not found.', 'NOT_FOUND');
    if (req.status !== 'PENDING') throw new MeetingError('This request has already been resolved.', 'STATE');
    const m = await lockMeeting(c, req.meeting_id);
    await c.query(`UPDATE meeting_reschedule_requests SET status='REJECTED', admin_remarks=$2, resolved_at=NOW() WHERE id=$1`,
                  [requestId, adminRemarks || null]);
    if (m.status === 'RESCHEDULE_REQUESTED') await c.query(`UPDATE startup_meetings SET status='SCHEDULED' WHERE id=$1`, [m.id]);
    await audit({ user: admin }, 'MEETING_RESCHEDULE_REJECTED', 'startup_meeting', m.id, { details: { startupId: m.startup_id } });
    return m.startup_id;
  });
}

export async function getHistory(startupId) {
  const r = await db.query(
    `SELECT sm.*, u1.name AS reviewer_name, u2.name AS created_by_name,
            mo.recommendation, mo.recorded_at AS outcome_recorded_at
     FROM startup_meetings sm
     LEFT JOIN users u1 ON u1.id = sm.reviewer_id
     LEFT JOIN users u2 ON u2.id = sm.created_by
     LEFT JOIN meeting_outcomes mo ON mo.meeting_id = sm.id
     WHERE sm.startup_id = $1 ORDER BY sm.starts_at DESC`, [startupId]);
  return r.rows;
}

/** Flags meetings that never got marked completed and whose end time has long passed. Idempotent; called by the scheduler. */
export async function markStaleAsNoShow(hoursGrace = 6) {
  const r = await db.query(
    `UPDATE startup_meetings SET status='NO_SHOW'
     WHERE status IN ('SCHEDULED','CONFIRMED') AND ends_at < NOW() - ($1 || ' hours')::interval
     RETURNING id, startup_id`, [hoursGrace]);
  return r.rows;
}
