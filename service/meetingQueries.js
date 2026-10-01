/** Read-only queries for startup-review-meeting screens. All parameterised. */
import db from '../config/db.js';

const BASE_SELECT = `
  SELECT sm.*, s.title AS startup_title, s.domain, s.student_id, s.status AS startup_status,
         stu.name AS student_name, stu.email AS student_email,
         rev.name AS reviewer_name, rev.email AS reviewer_email
  FROM startup_meetings sm
  JOIN startups s ON s.id = sm.startup_id
  JOIN users stu ON stu.id = s.student_id
  LEFT JOIN users rev ON rev.id = sm.reviewer_id`;

const VIEW_WHERE = {
  upcoming:  `sm.status IN ('SCHEDULED','CONFIRMED') AND sm.starts_at >= NOW()`,
  today:     `sm.status IN ('SCHEDULED','CONFIRMED') AND sm.meeting_date = CURRENT_DATE`,
  requested: `sm.status = 'RESCHEDULE_REQUESTED'`,
  completed: `sm.status = 'COMPLETED'`,
  cancelled: `sm.status IN ('CANCELLED','NO_SHOW')`,
  all:       `TRUE`,
};

export async function listAdminMeetings(view = 'upcoming') {
  const where = VIEW_WHERE[view] || VIEW_WHERE.upcoming;
  const order = view === 'completed' || view === 'cancelled' ? 'sm.starts_at DESC' : 'sm.starts_at ASC';
  const rows = await db.query(`${BASE_SELECT} WHERE ${where} ORDER BY ${order} LIMIT 200`);
  const counts = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('SCHEDULED','CONFIRMED') AND starts_at >= NOW())::int AS upcoming,
       COUNT(*) FILTER (WHERE status IN ('SCHEDULED','CONFIRMED') AND meeting_date = CURRENT_DATE)::int AS today,
       COUNT(*) FILTER (WHERE status = 'RESCHEDULE_REQUESTED')::int AS requested,
       COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
       COUNT(*) FILTER (WHERE status IN ('CANCELLED','NO_SHOW'))::int AS cancelled,
       COUNT(*)::int AS all
     FROM startup_meetings`);
  return { rows: rows.rows, counts: counts.rows[0] };
}

export async function getMeeting(id) {
  const m = (await db.query(`${BASE_SELECT} WHERE sm.id = $1`, [id])).rows[0];
  if (!m) return null;
  const [outcome, pendingRequest] = await Promise.all([
    db.query(`SELECT mo.*, u.name AS recorded_by_name FROM meeting_outcomes mo LEFT JOIN users u ON u.id = mo.recorded_by WHERE mo.meeting_id = $1`, [id]),
    db.query(`SELECT * FROM meeting_reschedule_requests WHERE meeting_id = $1 AND status = 'PENDING'`, [id]),
  ]);
  return { ...m, outcome: outcome.rows[0] || null, pendingRequest: pendingRequest.rows[0] || null };
}

export async function adminMeetingStats() {
  const [meetings, startups] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('SCHEDULED','CONFIRMED') AND starts_at >= NOW())::int AS upcoming,
         COUNT(*) FILTER (WHERE status IN ('SCHEDULED','CONFIRMED') AND meeting_date = CURRENT_DATE)::int AS today,
         COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
         COUNT(*) FILTER (WHERE status = 'RESCHEDULE_REQUESTED')::int AS reschedule_requested
       FROM startup_meetings`),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('pending','under_review'))::int AS pending_review,
         COUNT(*) FILTER (WHERE status = 'changes_requested')::int AS changes_requested,
         COUNT(*) FILTER (WHERE status = 'meeting_completed')::int AS awaiting_decision
       FROM startups WHERE is_deleted = false`),
  ]);
  return { ...meetings.rows[0], ...startups.rows[0] };
}

/** Next upcoming meeting across every startup this student owns (dashboard card). */
export async function studentUpcomingMeeting(studentId) {
  const r = await db.query(
    `${BASE_SELECT} WHERE s.student_id = $1 AND sm.status IN ('SCHEDULED','CONFIRMED') AND sm.starts_at >= NOW()
     ORDER BY sm.starts_at ASC LIMIT 1`, [studentId]);
  return r.rows[0] || null;
}

export async function studentMeetings(studentId, view = 'upcoming') {
  const where = view === 'past'
    ? `(sm.status IN ('COMPLETED','CANCELLED','NO_SHOW') OR sm.ends_at < NOW())`
    : `sm.status IN ('SCHEDULED','CONFIRMED','RESCHEDULE_REQUESTED') AND sm.ends_at >= NOW()`;
  const r = await db.query(
    `${BASE_SELECT} WHERE s.student_id = $1 AND ${where}
     ORDER BY sm.starts_at ${view === 'past' ? 'DESC' : 'ASC'} LIMIT 100`, [studentId]);
  return r.rows;
}

export async function getMeetingForStudent(id, studentId) {
  const m = (await db.query(`${BASE_SELECT} WHERE sm.id = $1 AND s.student_id = $2`, [id, studentId])).rows[0];
  if (!m) return null;
  const pendingRequest = await db.query(`SELECT * FROM meeting_reschedule_requests WHERE meeting_id = $1 AND status = 'PENDING'`, [id]);
  return { ...m, pendingRequest: pendingRequest.rows[0] || null };
}
