/**
 * notificationService: the single entry point routes use to announce business events.
 *
 *   await notificationService.startupSubmitted(startupId);
 *
 * Design rules
 *  1. Routes pass IDs. This service loads names/emails from the DB itself, so a
 *     recipient address is never taken from request input.
 *  2. In-app rows are written before returning (so the bell is right on the very
 *     next page). Emails go onto a small serial in-process queue and are sent in
 *     the background, so a slow SMTP server never slows a request.
 *  3. Nothing in here can throw into a route. Every public method is wrapped.
 *  4. Idempotent: each delivery carries a dedupe key (unique per recipient).
 *
 * Scaling seam: replace `enqueueEmail` with `queue.add('email', job)` (BullMQ /
 * SQS) and run `sendTemplatedEmail` in a worker. Nothing else changes.
 *
 * Resource-management events (requests, issuing, returns, bookings, issues,
 * maintenance) follow exactly this pattern and were added in the same style —
 * see the "RESOURCE MANAGEMENT" section below the startup/funding events.
 */
import db from '../config/db.js';
import { sendTemplatedEmail } from './emailService.js';
import { templateMeta } from './emailTemplates.js';
import { createNotification, emailEnabled } from './notificationStore.js';
import { markOverdue } from './resourceService.js';

/* ── helpers ─────────────────────────────────────────────────────────────── */
const one = async (sql, params) => (await db.query(sql, params)).rows[0] || null;
const baseUrl = () => (process.env.APP_BASE_URL || process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const abs = (p) => baseUrl() + p;
const TZ = () => process.env.APP_TIMEZONE || 'Asia/Kolkata';
const fmtDate = (d) => new Date(d).toLocaleString('en-IN', { timeZone: TZ(), day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
const ver = (d) => new Date(d).getTime();
const excerpt = (s, n = 160) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};
export const dashboardPath = (role) => `/${['admin', 'mentor'].includes(role) ? role : 'student'}/dashboard`;

/* ── in-process serial email queue (the swap-out point for BullMQ etc.) ───── */
let chain = Promise.resolve();
function enqueueEmail(job) {
  chain = chain
    .then(() => sendTemplatedEmail(job))
    .catch((e) => console.error('[notify] email job crashed:', e.message));
  return chain;
}
/** Resolves when every queued email has been attempted (tests / graceful shutdown). */
export const drain = () => chain;

/* ── delivery primitives ─────────────────────────────────────────────────── */
async function deliver({ to, inApp, email, dedupeKey = null, entity = {} }) {
  if (inApp && to.id) {
    const created = await createNotification({
      userId: to.id, ...inApp, entityType: entity.type, entityId: entity.id, dedupeKey,
    });
    if (!created) return 'duplicate';               // event already processed for this user
  }
  if (email && to.email) {
    const meta = templateMeta(email.template);
    if (await emailEnabled(to.id, meta.category, meta.mandatory)) {
      enqueueEmail({
        to: to.email, template: email.template, data: { name: to.name, ...email.data },
        userId: to.id ?? null, entityType: entity.type, entityId: entity.id, dedupeKey,
      });
    }
  }
  return 'ok';
}

/**
 * Admin fan-out. In-app goes to every admin account. Email goes to ADMIN_EMAIL
 * (one shared inbox, comma-separated allowed) if configured, otherwise to each admin.
 */
async function notifyAdmins({ inApp, email, dedupeKey, entity }) {
  const admins = (await db.query(`SELECT id, name, email FROM users WHERE role = 'admin'`)).rows;
  const shared = (process.env.ADMIN_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of admins) {
    await deliver({ to: a, inApp, email: shared.length ? null : email, dedupeKey, entity });
  }
  for (const addr of shared) {
    await deliver({ to: { id: null, name: 'Incubation Cell', email: addr }, email, dedupeKey, entity });
  }
}

/** Wrap so no public method can ever throw into the calling route. */
const safe = (name, fn) => async (...args) => {
  try { return await fn(...args); }
  catch (err) { console.error(`[notify] ${name} failed:`, err.message); return null; }
};

/* ── data loaders ────────────────────────────────────────────────────────── */
const loadStartup = (id) => one(
  `SELECT s.*, u.name AS student_name, u.email AS student_email
   FROM startups s JOIN users u ON u.id = s.student_id WHERE s.id = $1`, [id]);

const loadFunding = (id) => one(
  `SELECT fr.*, s.title AS startup_title, s.domain, s.student_id,
          u.name AS student_name, u.email AS student_email
   FROM funding_requests fr
   JOIN startups s ON s.id = fr.startup_id
   JOIN users u ON u.id = s.student_id WHERE fr.id = $1`, [id]);

/* ═══════════════════════════ PUBLIC EVENTS ═══════════════════════════════ */

/* ── Account ─────────────────────────────────────────────────────────────── */
const userRegistered = safe('userRegistered', async (user) => {
  await deliver({
    to: user,
    dedupeKey: `WELCOME:${user.id}`,                 // never welcome the same account twice
    entity: { type: 'user', id: user.id },
    inApp: {
      type: 'WELCOME', title: 'Welcome to IncuPortal',
      message: user.role === 'mentor'
        ? 'Your mentor account is active. Assigned startups will appear on your dashboard.'
        : 'Your account is ready. Submit your first startup idea to get started.',
      link: dashboardPath(user.role),
    },
    email: { template: 'welcome', data: { role: user.role, url: abs(dashboardPath(user.role)) } },
  });
});

/** The reset link is passed straight into the email data. It is never stored or logged. */
const passwordResetRequested = safe('passwordResetRequested', async ({ user, resetLink }) => {
  await deliver({
    to: user, entity: { type: 'user', id: user.id },
    email: { template: 'password-reset', data: { url: resetLink } },
  });
});

const passwordChanged = safe('passwordChanged', async (user) => {
  await deliver({
    to: user, entity: { type: 'user', id: user.id },
    inApp: { type: 'PASSWORD_CHANGED', title: 'Password changed', message: 'Your password was changed. If this was not you, reset it immediately.', link: null },
    email: { template: 'password-changed', data: { changedAt: fmtDate(new Date()), url: abs('/auth/login') } },
  });
});

const userRoleChanged = safe('userRoleChanged', async ({ userId, oldRole, newRole }) => {
  if (oldRole === newRole) return;
  const u = await one(`SELECT id, name, email, role FROM users WHERE id = $1`, [userId]);
  if (!u) return;
  await deliver({
    to: u, entity: { type: 'user', id: u.id },
    inApp: { type: 'ROLE_CHANGED', title: 'Your role was updated', message: `An administrator changed your role from ${oldRole} to ${newRole}.`, link: dashboardPath(newRole) },
    email: { template: 'role-changed', data: { oldRole, newRole, url: abs(dashboardPath(newRole)) } },
  });
});

/* ── Startups ────────────────────────────────────────────────────────────── */
const startupSubmitted = safe('startupSubmitted', async (startupId) => {
  const s = await loadStartup(startupId);
  if (!s) return;
  const key = `STARTUP_SUBMITTED:${s.id}`;
  const entity = { type: 'startup', id: s.id };
  const common = { startupTitle: s.title, domain: s.domain, stage: s.stage, submittedAt: fmtDate(s.created_at) };

  await deliver({
    to: { id: s.student_id, name: s.student_name, email: s.student_email }, dedupeKey: key, entity,
    inApp: { type: 'STARTUP_SUBMITTED', title: 'Startup submitted', message: `"${s.title}" was submitted and is awaiting review.`, link: `/student/startup/${s.id}` },
    email: { template: 'startup-submitted', data: { ...common, url: abs(`/student/startup/${s.id}`) } },
  });
  await notifyAdmins({
    dedupeKey: key, entity,
    inApp: { type: 'STARTUP_SUBMITTED', title: 'New startup awaiting review', message: `${s.student_name} submitted "${s.title}" (${s.domain}, ${s.stage}).`, link: `/admin/startup/${s.id}` },
    email: { template: 'startup-submitted-admin', data: { ...common, studentName: s.student_name, studentEmail: s.student_email, url: abs(`/admin/startup/${s.id}`) } },
  });
});

/** Call after the status UPDATE succeeded AND actually changed the status. */
const startupReviewed = safe('startupReviewed', async (startupId) => {
  const s = await loadStartup(startupId);
  if (!s || !['approved', 'rejected'].includes(s.status)) return;
  const approved = s.status === 'approved';
  await deliver({
    to: { id: s.student_id, name: s.student_name, email: s.student_email },
    dedupeKey: `STARTUP_${s.status.toUpperCase()}:${s.id}:${ver(s.updated_at)}`,   // re-decisions later get a fresh key
    entity: { type: 'startup', id: s.id },
    inApp: {
      type: approved ? 'STARTUP_APPROVED' : 'STARTUP_REJECTED',
      title: approved ? 'Startup approved 🎉' : 'Update on your startup submission',
      message: approved ? `"${s.title}" was approved.` : `"${s.title}" was reviewed. Open it to read the feedback.`,
      link: `/student/startup/${s.id}`,
    },
    email: { template: approved ? 'startup-approved' : 'startup-rejected',
             data: { startupTitle: s.title, domain: s.domain, stage: s.stage, adminRemark: s.admin_remark || '', url: abs(`/student/startup/${s.id}`) } },
  });
});

const mentorAssigned = safe('mentorAssigned', async (assignmentId) => {
  const a = await one(`SELECT id, startup_id, mentor_id FROM mentor_assignments WHERE id = $1`, [assignmentId]);
  if (!a) return;
  const [s, m] = await Promise.all([loadStartup(a.startup_id), one(`SELECT id, name, email FROM users WHERE id = $1`, [a.mentor_id])]);
  if (!s || !m) return;
  const key = `MENTOR_ASSIGNED:${a.id}`;
  const entity = { type: 'startup', id: s.id };

  await deliver({
    to: { id: s.student_id, name: s.student_name, email: s.student_email }, dedupeKey: key, entity,
    inApp: { type: 'MENTOR_ASSIGNED', title: 'Mentor assigned', message: `${m.name} is now mentoring "${s.title}".`, link: `/student/startup/${s.id}` },
    email: { template: 'mentor-assigned-student', data: { startupTitle: s.title, domain: s.domain, mentorName: m.name, mentorEmail: m.email, url: abs(`/student/startup/${s.id}`) } },
  });
  await deliver({
    to: m, dedupeKey: key, entity,
    inApp: { type: 'MENTOR_ASSIGNED', title: 'New startup assigned', message: `You were assigned to mentor "${s.title}" (${s.student_name}).`, link: `/mentor/startup/${s.id}` },
    email: { template: 'mentor-assigned-mentor', data: { startupTitle: s.title, domain: s.domain, description: excerpt(s.description, 300), studentName: s.student_name, studentEmail: s.student_email, url: abs(`/mentor/startup/${s.id}`) } },
  });
});

/** In-app only: removal is worth recording but not worth an email. */
const mentorRemoved = safe('mentorRemoved', async ({ startupId, mentorId }) => {
  const [s, m] = await Promise.all([loadStartup(startupId), one(`SELECT id, name, email FROM users WHERE id = $1`, [mentorId])]);
  if (!s || !m) return;
  const entity = { type: 'startup', id: s.id };
  await deliver({ to: { id: s.student_id }, entity,
    inApp: { type: 'MENTOR_REMOVED', title: 'Mentor changed', message: `${m.name} is no longer assigned to "${s.title}".`, link: `/student/startup/${s.id}` } });
  await deliver({ to: m, entity,
    inApp: { type: 'MENTOR_REMOVED', title: 'Assignment ended', message: `You are no longer assigned to "${s.title}".`, link: '/mentor/dashboard' } });
});

/* ── Funding ─────────────────────────────────────────────────────────────── */
const fundingSubmitted = safe('fundingSubmitted', async (fundingId) => {
  const f = await loadFunding(fundingId);
  if (!f) return;
  const key = `FUNDING_SUBMITTED:${f.id}`;
  const entity = { type: 'funding', id: f.id };
  const common = { startupTitle: f.startup_title, amount: inr(f.amount_requested), purpose: excerpt(f.purpose, 300),
                   proposal: f.proposal_file ? 'Attached' : 'Not attached', submittedAt: fmtDate(f.created_at) };

  await deliver({
    to: { id: f.student_id, name: f.student_name, email: f.student_email }, dedupeKey: key, entity,
    inApp: { type: 'FUNDING_SUBMITTED', title: 'Funding request submitted', message: `Your request for ${inr(f.amount_requested)} on "${f.startup_title}" is awaiting review.`, link: `/student/startup/${f.startup_id}` },
    email: { template: 'funding-submitted', data: { ...common, url: abs(`/student/startup/${f.startup_id}`) } },
  });
  await notifyAdmins({
    dedupeKey: key, entity,
    inApp: { type: 'FUNDING_SUBMITTED', title: 'New funding request', message: `${f.student_name} requested ${inr(f.amount_requested)} for "${f.startup_title}".`, link: '/admin/funding' },
    email: { template: 'funding-submitted-admin', data: { ...common, studentName: f.student_name, studentEmail: f.student_email, url: abs('/admin/funding') } },
  });
});

const fundingReviewed = safe('fundingReviewed', async (fundingId) => {
  const f = await loadFunding(fundingId);
  if (!f || !['approved', 'rejected'].includes(f.status)) return;
  const approved = f.status === 'approved';
  await deliver({
    to: { id: f.student_id, name: f.student_name, email: f.student_email },
    dedupeKey: `FUNDING_${f.status.toUpperCase()}:${f.id}:${ver(f.updated_at)}`,
    entity: { type: 'funding', id: f.id },
    inApp: {
      type: approved ? 'FUNDING_APPROVED' : 'FUNDING_REJECTED',
      title: approved ? 'Funding approved' : 'Funding request update',
      message: approved ? `Your ${inr(f.amount_requested)} request for "${f.startup_title}" was approved.`
                        : `Your ${inr(f.amount_requested)} request for "${f.startup_title}" was not approved.`,
      link: `/student/startup/${f.startup_id}`,
    },
    email: { template: approved ? 'funding-approved' : 'funding-rejected',
             data: { startupTitle: f.startup_title, amount: inr(f.amount_requested), purpose: excerpt(f.purpose, 300), adminRemark: f.admin_remark || '', url: abs(`/student/startup/${f.startup_id}`) } },
  });
});

/* ── Mentor feedback & progress ──────────────────────────────────────────── */
const mentorFeedbackAdded = safe('mentorFeedbackAdded', async (feedbackId) => {
  const f = await one(
    `SELECT mf.*, s.title, s.student_id, su.name AS student_name, su.email AS student_email, m.name AS mentor_name
     FROM mentor_feedback mf
     JOIN startups s ON s.id = mf.startup_id
     JOIN users su ON su.id = s.student_id
     JOIN users m  ON m.id = mf.mentor_id WHERE mf.id = $1`, [feedbackId]);
  if (!f) return;
  await deliver({
    to: { id: f.student_id, name: f.student_name, email: f.student_email },
    dedupeKey: `MENTOR_FEEDBACK:${f.id}`, entity: { type: 'startup', id: f.startup_id },
    inApp: { type: 'MENTOR_FEEDBACK', title: 'New mentor feedback', message: `${f.mentor_name} left feedback on "${f.title}".`, link: `/student/startup/${f.startup_id}` },
    email: { template: 'mentor-feedback', data: { startupTitle: f.title, mentorName: f.mentor_name, excerpt: excerpt(f.feedback, 200), date: fmtDate(f.created_at), url: abs(`/student/startup/${f.startup_id}`) } },
  });
});

const progressUpdateAdded = safe('progressUpdateAdded', async (updateId) => {
  const p = await one(
    `SELECT pu.*, s.title, u.name AS author_name
     FROM progress_updates pu JOIN startups s ON s.id = pu.startup_id JOIN users u ON u.id = pu.author_id
     WHERE pu.id = $1`, [updateId]);
  if (!p) return;
  const mentors = (await db.query(
    `SELECT u.id, u.name, u.email FROM mentor_assignments ma JOIN users u ON u.id = ma.mentor_id WHERE ma.startup_id = $1`,
    [p.startup_id])).rows;
  for (const m of mentors) {
    await deliver({
      to: m, dedupeKey: `PROGRESS_UPDATE:${p.id}`, entity: { type: 'startup', id: p.startup_id },
      inApp: { type: 'PROGRESS_UPDATE', title: 'New progress update', message: `${p.author_name} posted an update on "${p.title}".`, link: `/mentor/startup/${p.startup_id}` },
      email: { template: 'progress-update', data: { startupTitle: p.title, studentName: p.author_name, excerpt: excerpt(p.description, 200), date: fmtDate(p.created_at), url: abs(`/mentor/startup/${p.startup_id}`) } },
    });
  }
});

/* ═══════════════════ RESOURCE MANAGEMENT ═══════════════════════════════════
 * Same shape as everything above: routes pass an id, this loads the row(s)
 * itself, dedupeKey makes every call idempotent, and a failed email never
 * rolls back the resource transaction (the route already committed by the
 * time it calls these). */

const loadResourceRequest = (id) => one(
  `SELECT q.*, r.name AS resource_name, r.asset_code, r.resource_type, s.title AS startup_title,
          u.id AS user_id, u.name AS student_name, u.email AS student_email
   FROM resource_requests q JOIN resources r ON r.id = q.resource_id JOIN users u ON u.id = q.user_id
   LEFT JOIN startups s ON s.id = q.startup_id WHERE q.id = $1`, [id]);

const loadAssignment = (id) => one(
  `SELECT a.*, r.name AS resource_name, r.asset_code, u.id AS user_id, u.name AS student_name, u.email AS student_email
   FROM resource_assignments a JOIN resources r ON r.id = a.resource_id JOIN users u ON u.id = a.user_id WHERE a.id = $1`, [id]);

const loadBooking = (id) => one(
  `SELECT b.*, r.name AS resource_name, r.asset_code, u.id AS user_id, u.name AS student_name, u.email AS student_email
   FROM resource_bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id WHERE b.id = $1`, [id]);

const loadIssue = (id) => one(
  `SELECT i.*, r.name AS resource_name, r.asset_code,
          u.id AS reporter_id, u.name AS reporter_name, u.email AS reporter_email
   FROM resource_issues i JOIN resources r ON r.id = i.resource_id LEFT JOIN users u ON u.id = i.reported_by WHERE i.id = $1`, [id]);

const loadMaintenance = (id) => one(
  `SELECT m.*, r.name AS resource_name, r.asset_code,
          i.reported_by AS reporter_id, ru.name AS reporter_name, ru.email AS reporter_email
   FROM resource_maintenance m JOIN resources r ON r.id = m.resource_id
   LEFT JOIN resource_issues i ON i.id = m.issue_id LEFT JOIN users ru ON ru.id = i.reported_by WHERE m.id = $1`, [id]);

const fmtSlot = (b) => `${fmtDate(b.booking_date).split(',')[0]}, ${String(b.start_time).slice(0, 5)}–${String(b.end_time).slice(0, 5)}`;

/* ── Requests ─────────────────────────────────────────────────────────────── */
const resourceRequestSubmitted = safe('resourceRequestSubmitted', async (requestId) => {
  const q = await loadResourceRequest(requestId);
  if (!q) return;
  const key = `RESOURCE_REQUEST_SUBMITTED:${q.id}`;
  const entity = { type: 'resource_request', id: q.id };
  const common = { resourceName: q.resource_name, assetCode: q.asset_code, quantity: q.quantity, purpose: excerpt(q.purpose, 300),
                   requestedFrom: fmtDate(q.requested_from).split(',')[0], requestedUntil: fmtDate(q.requested_until).split(',')[0] };

  await deliver({
    to: { id: q.user_id, name: q.student_name, email: q.student_email }, dedupeKey: key, entity,
    inApp: { type: 'RESOURCE_REQUEST_SUBMITTED', title: 'Request submitted', message: `Your request for ${q.resource_name} is awaiting review.`, link: '/student/my-resources' },
    email: { template: 'resource-request-submitted', data: { ...common, url: abs('/student/my-resources') } },
  });
  await notifyAdmins({
    dedupeKey: key, entity,
    inApp: { type: 'RESOURCE_REQUEST_SUBMITTED', title: 'New resource request', message: `${q.student_name} requested ${q.resource_name}${q.startup_title ? ` for "${q.startup_title}"` : ''}.`, link: '/admin/resources/requests' },
    email: { template: 'resource-request-submitted-admin', data: { ...common, studentName: q.student_name, startupTitle: q.startup_title || '—', url: abs('/admin/resources/requests') } },
  });
});

const resourceRequestApproved = safe('resourceRequestApproved', async (requestId) => {
  const q = await loadResourceRequest(requestId);
  if (!q || q.status !== 'APPROVED') return;
  await deliver({
    to: { id: q.user_id, name: q.student_name, email: q.student_email },
    dedupeKey: `RESOURCE_REQUEST_APPROVED:${q.id}:${ver(q.updated_at)}`, entity: { type: 'resource_request', id: q.id },
    inApp: { type: 'RESOURCE_REQUEST_APPROVED', title: 'Request approved', message: `Your request for ${q.resource_name} was approved. It will be issued shortly.`, link: '/student/my-resources' },
    email: { template: 'resource-request-approved', data: { resourceName: q.resource_name, assetCode: q.asset_code, url: abs('/student/my-resources') } },
  });
});

const resourceRequestRejected = safe('resourceRequestRejected', async (requestId) => {
  const q = await loadResourceRequest(requestId);
  if (!q || q.status !== 'REJECTED') return;
  await deliver({
    to: { id: q.user_id, name: q.student_name, email: q.student_email },
    dedupeKey: `RESOURCE_REQUEST_REJECTED:${q.id}:${ver(q.updated_at)}`, entity: { type: 'resource_request', id: q.id },
    inApp: { type: 'RESOURCE_REQUEST_REJECTED', title: 'Request update', message: `Your request for ${q.resource_name} was not approved.`, link: '/student/my-resources' },
    email: { template: 'resource-request-rejected', data: { resourceName: q.resource_name, adminRemark: q.admin_remarks || '', url: abs('/student/my-resources') } },
  });
});

/* ── Issue / return ──────────────────────────────────────────────────────── */
const resourceIssued = safe('resourceIssued', async (assignmentId) => {
  const a = await loadAssignment(assignmentId);
  if (!a) return;
  await deliver({
    to: { id: a.user_id, name: a.student_name, email: a.student_email },
    dedupeKey: `RESOURCE_ISSUED:${a.id}`, entity: { type: 'resource_assignment', id: a.id },
    inApp: { type: 'RESOURCE_ISSUED', title: 'Resource issued', message: `${a.resource_name} (${a.asset_code}) has been issued to you. Due ${fmtDate(a.expected_return_at).split(',')[0]}.`, link: '/student/my-resources' },
    email: { template: 'resource-issued', data: { resourceName: a.resource_name, assetCode: a.asset_code, dueDate: fmtDate(a.expected_return_at), condition: a.issue_condition, url: abs('/student/my-resources') } },
  });
});

const resourceReturned = safe('resourceReturned', async (assignmentId) => {
  const a = await loadAssignment(assignmentId);
  if (!a || !['RETURNED', 'DAMAGED', 'LOST'].includes(a.status)) return;
  const clean = a.status === 'RETURNED';
  await deliver({
    to: { id: a.user_id, name: a.student_name, email: a.student_email },
    dedupeKey: `RESOURCE_RETURNED:${a.id}`, entity: { type: 'resource_assignment', id: a.id },
    inApp: { type: 'RESOURCE_RETURNED', title: 'Return recorded', message: clean ? `Your return of ${a.resource_name} was recorded. Thanks!` : `Your return of ${a.resource_name} was recorded — logged as ${a.return_condition?.toLowerCase().replace(/_/g, ' ')}.`, link: '/student/my-resources' },
    email: { template: 'resource-returned', data: { resourceName: a.resource_name, assetCode: a.asset_code, condition: a.return_condition, clean, url: abs('/student/my-resources') } },
  });
});

/* ── Issues / maintenance ─────────────────────────────────────────────────── */
const resourceIssueReported = safe('resourceIssueReported', async (issueId) => {
  const i = await loadIssue(issueId);
  if (!i) return;
  await notifyAdmins({
    dedupeKey: `RESOURCE_ISSUE_REPORTED:${i.id}`, entity: { type: 'resource_issue', id: i.id },
    inApp: { type: 'RESOURCE_ISSUE_REPORTED', title: 'Resource issue reported', message: `${i.reporter_name || 'Someone'} reported ${i.issue_type.toLowerCase()} on ${i.resource_name} (${i.asset_code}).`, link: '/admin/resources/issues' },
    email: { template: 'resource-issue-reported-admin', data: { resourceName: i.resource_name, assetCode: i.asset_code, issueType: i.issue_type, description: excerpt(i.description, 300), reporterName: i.reporter_name || 'Admin', url: abs('/admin/resources/issues') } },
  });
});

const resourceMaintenanceStarted = safe('resourceMaintenanceStarted', async (maintenanceId) => {
  const m = await loadMaintenance(maintenanceId);
  if (!m || !m.reporter_id) return;   // only the student who reported it (if any) gets notified; ad-hoc maintenance has no one to tell
  await deliver({
    to: { id: m.reporter_id, name: m.reporter_name, email: m.reporter_email },
    dedupeKey: `RESOURCE_MAINTENANCE_STARTED:${m.id}`, entity: { type: 'resource_maintenance', id: m.id },
    inApp: { type: 'RESOURCE_MAINTENANCE_STARTED', title: 'Maintenance started', message: `${m.resource_name} (${m.asset_code}) has gone in for maintenance following your report.`, link: '/student/resources' },
    email: { template: 'resource-maintenance-started', data: { resourceName: m.resource_name, assetCode: m.asset_code, url: abs('/student/resources') } },
  });
});

const resourceMaintenanceCompleted = safe('resourceMaintenanceCompleted', async (maintenanceId) => {
  const m = await loadMaintenance(maintenanceId);
  if (!m) return;
  if (m.reporter_id) {
    await deliver({
      to: { id: m.reporter_id, name: m.reporter_name, email: m.reporter_email },
      dedupeKey: `RESOURCE_MAINTENANCE_COMPLETED:${m.id}`, entity: { type: 'resource_maintenance', id: m.id },
      inApp: { type: 'RESOURCE_MAINTENANCE_COMPLETED', title: 'Maintenance completed', message: `${m.resource_name} (${m.asset_code}) is repaired and available again.`, link: '/student/resources' },
      email: { template: 'resource-maintenance-completed', data: { resourceName: m.resource_name, assetCode: m.asset_code, url: abs('/student/resources') } },
    });
  }
});

/* ── Bookings ─────────────────────────────────────────────────────────────── */
const resourceBookingSubmitted = safe('resourceBookingSubmitted', async (bookingId) => {
  const b = await loadBooking(bookingId);
  if (!b) return;
  const key = `RESOURCE_BOOKING_SUBMITTED:${b.id}`;
  const entity = { type: 'resource_booking', id: b.id };
  const common = { resourceName: b.resource_name, assetCode: b.asset_code, slot: fmtSlot(b), purpose: excerpt(b.purpose, 300) };

  await deliver({
    to: { id: b.user_id, name: b.student_name, email: b.student_email }, dedupeKey: key, entity,
    inApp: { type: 'RESOURCE_BOOKING_SUBMITTED', title: 'Booking submitted', message: `Your booking for ${b.resource_name} (${fmtSlot(b)}) is awaiting approval.`, link: '/student/my-bookings' },
    email: { template: 'resource-booking-submitted', data: { ...common, url: abs('/student/my-bookings') } },
  });
  await notifyAdmins({
    dedupeKey: key, entity,
    inApp: { type: 'RESOURCE_BOOKING_SUBMITTED', title: 'New booking request', message: `${b.student_name} requested ${b.resource_name} (${fmtSlot(b)}).`, link: '/admin/resources/bookings' },
    email: { template: 'resource-booking-submitted-admin', data: { ...common, studentName: b.student_name, url: abs('/admin/resources/bookings') } },
  });
});

const resourceBookingApproved = safe('resourceBookingApproved', async (bookingId) => {
  const b = await loadBooking(bookingId);
  if (!b || b.status !== 'APPROVED') return;
  await deliver({
    to: { id: b.user_id, name: b.student_name, email: b.student_email },
    dedupeKey: `RESOURCE_BOOKING_APPROVED:${b.id}:${ver(b.updated_at)}`, entity: { type: 'resource_booking', id: b.id },
    inApp: { type: 'RESOURCE_BOOKING_APPROVED', title: 'Booking approved', message: `Your booking for ${b.resource_name} (${fmtSlot(b)}) is confirmed.`, link: '/student/my-bookings' },
    email: { template: 'resource-booking-approved', data: { resourceName: b.resource_name, slot: fmtSlot(b), url: abs('/student/my-bookings') } },
  });
});

const resourceBookingRejected = safe('resourceBookingRejected', async (bookingId) => {
  const b = await loadBooking(bookingId);
  if (!b || b.status !== 'REJECTED') return;
  await deliver({
    to: { id: b.user_id, name: b.student_name, email: b.student_email },
    dedupeKey: `RESOURCE_BOOKING_REJECTED:${b.id}:${ver(b.updated_at)}`, entity: { type: 'resource_booking', id: b.id },
    inApp: { type: 'RESOURCE_BOOKING_REJECTED', title: 'Booking update', message: `Your booking for ${b.resource_name} (${fmtSlot(b)}) was not approved.`, link: '/student/my-bookings' },
    email: { template: 'resource-booking-rejected', data: { resourceName: b.resource_name, slot: fmtSlot(b), adminRemark: b.admin_remarks || '', url: abs('/student/my-bookings') } },
  });
});

/* ── Overdue + reminders (called by admin page loads AND the scheduler; both
 * paths are naturally idempotent — markOverdue()'s own WHERE clause only ever
 * flags a row once, and every notification below carries a dedupe key too). ── */
const resourceOverdueCheck = safe('resourceOverdueCheck', async () => {
  const rows = await markOverdue();
  for (const row of rows) {
    const a = await loadAssignment(row.id);
    if (!a) continue;
    await deliver({
      to: { id: a.user_id, name: a.student_name, email: a.student_email },
      dedupeKey: `RESOURCE_OVERDUE:${a.id}`, entity: { type: 'resource_assignment', id: a.id },
      inApp: { type: 'RESOURCE_OVERDUE', title: 'Resource overdue', message: `${a.resource_name} (${a.asset_code}) was due back on ${fmtDate(a.expected_return_at).split(',')[0]}. Please return it.`, link: '/student/my-resources' },
      email: { template: 'resource-overdue', data: { resourceName: a.resource_name, assetCode: a.asset_code, dueDate: fmtDate(a.expected_return_at), url: abs('/student/my-resources') } },
    });
  }
  return rows.length;
});

/** Scheduler entry point: sends a reminder 3 days before, 1 day before, and on the due date. */
const sendReturnReminders = safe('sendReturnReminders', async () => {
  const rows = (await db.query(
    `SELECT a.id, GREATEST(0, (a.expected_return_at::date - CURRENT_DATE))::int AS days_left
     FROM resource_assignments a WHERE a.status = 'ACTIVE'
       AND a.expected_return_at::date - CURRENT_DATE IN (3, 1, 0)`)).rows;
  let sent = 0;
  for (const row of rows) {
    const a = await loadAssignment(row.id);
    if (!a) continue;
    const when = row.days_left === 0 ? 'today' : `in ${row.days_left} day${row.days_left > 1 ? 's' : ''}`;
    const res = await deliver({
      to: { id: a.user_id, name: a.student_name, email: a.student_email },
      dedupeKey: `RESOURCE_RETURN_REMINDER:${a.id}:${row.days_left}`, entity: { type: 'resource_assignment', id: a.id },
      inApp: { type: 'RESOURCE_RETURN_REMINDER', title: 'Return reminder', message: `${a.resource_name} (${a.asset_code}) is due back ${when}.`, link: '/student/my-resources' },
      email: { template: 'resource-return-reminder', data: { resourceName: a.resource_name, assetCode: a.asset_code, when, dueDate: fmtDate(a.expected_return_at), url: abs('/student/my-resources') } },
    });
    if (res === 'ok') sent++;
  }
  return sent;
});

/** Scheduler entry point: reminds a student the day before an approved booking. */
const sendBookingReminders = safe('sendBookingReminders', async () => {
  const rows = (await db.query(
    `SELECT id FROM resource_bookings WHERE status = 'APPROVED' AND booking_date = CURRENT_DATE + INTERVAL '1 day'`)).rows;
  let sent = 0;
  for (const row of rows) {
    const b = await loadBooking(row.id);
    if (!b) continue;
    const res = await deliver({
      to: { id: b.user_id, name: b.student_name, email: b.student_email },
      dedupeKey: `RESOURCE_BOOKING_REMINDER:${b.id}`, entity: { type: 'resource_booking', id: b.id },
      inApp: { type: 'RESOURCE_BOOKING_REMINDER', title: 'Booking tomorrow', message: `Reminder: your booking for ${b.resource_name} is tomorrow (${fmtSlot(b)}).`, link: '/student/my-bookings' },
      email: { template: 'resource-booking-reminder', data: { resourceName: b.resource_name, slot: fmtSlot(b), url: abs('/student/my-bookings') } },
    });
    if (res === 'ok') sent++;
  }
  return sent;
});

export default {
  userRegistered, passwordResetRequested, passwordChanged, userRoleChanged,
  startupSubmitted, startupReviewed, mentorAssigned, mentorRemoved,
  fundingSubmitted, fundingReviewed, mentorFeedbackAdded, progressUpdateAdded,
  resourceRequestSubmitted, resourceRequestApproved, resourceRequestRejected,
  resourceIssued, resourceReturned, resourceIssueReported,
  resourceMaintenanceStarted, resourceMaintenanceCompleted,
  resourceBookingSubmitted, resourceBookingApproved, resourceBookingRejected,
  resourceOverdueCheck, sendReturnReminders, sendBookingReminders,
  drain,
};
