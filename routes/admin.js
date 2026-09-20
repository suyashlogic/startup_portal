import express from "express";
import db from '../config/db.js';
import { requireAdmin } from '../middleware/authMiddleware.js';
import notificationService from '../service/notificationService.js';
import { audit, recentActivity } from '../service/auditService.js';
import { unreadCount } from '../service/notificationStore.js';
import { TEMPLATE_KEYS } from '../service/emailTemplates.js';

const router = express.Router();

router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const [startupsResult, usersResult, fundingResult, recentResult] = await Promise.all([
      db.query(
        `SELECT status FROM startups WHERE is_deleted = false`
      ),
      db.query(
        `SELECT role, COUNT(*) AS count FROM users
         WHERE role IN ('student','mentor')
         GROUP BY role`
      ),
      db.query(
        `SELECT status, COALESCE(SUM(amount_requested), 0) AS total
         FROM funding_requests
         GROUP BY status`
      ),
      db.query(
        `SELECT s.*, u.name AS student_name
         FROM startups s
         JOIN users u ON u.id = s.student_id
         WHERE s.is_deleted = false
         ORDER BY s.created_at DESC
         LIMIT 5`
      )
    ]);

    // Build stats.startups
    const rows = startupsResult.rows;
    const startupStats = {
      total:    rows.length,
      pending:  rows.filter(r => r.status === 'pending').length,
      approved: rows.filter(r => r.status === 'approved').length,
      rejected: rows.filter(r => r.status === 'rejected').length,
    };

    // Build stats.users
    const userStats = { students: 0, mentors: 0 };
    usersResult.rows.forEach(r => {
      if (r.role === 'student') userStats.students = parseInt(r.count);
      if (r.role === 'mentor')  userStats.mentors  = parseInt(r.count);
    });

    // Build stats.funding
    const fundingStats = { total_approved: 0, pending: 0 };
    fundingResult.rows.forEach(r => {
      if (r.status === 'approved') fundingStats.total_approved = parseFloat(r.total);
      if (r.status === 'pending')  fundingStats.pending++;
    });
    // pending count separately
    const pendingFunding = await db.query(
      `SELECT COUNT(*) AS count FROM funding_requests WHERE status = 'pending'`
    );
    fundingStats.pending = parseInt(pendingFunding.rows[0].count);

    const [failedEmails, unread, activity] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS n FROM email_logs
                WHERE status = 'failed' AND created_at > NOW() - INTERVAL '7 days'`),
      unreadCount(req.user.id),
      recentActivity(8)
    ]);

    res.render('admin/dashboard', {
      title: 'Admin Dashboard',
      stats: {
        startups: startupStats,
        users:    userStats,
        funding:  fundingStats
      },
      ops: { failedEmails: failedEmails.rows[0].n, unread, activity },
      recentStartups: recentResult.rows
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    req.flash('error', 'Error loading dashboard.');
    res.redirect('/');
  }
});

// ── GET /admin/startups ──────────────────────────────────────────
// startups.ejs expects:
//   startups[]  (with student_name)
//   filters.{ search, status }   ← from query params
router.get('/startups', requireAdmin, async (req, res) => {
  try {
    const { search = '', status = '' } = req.query;

    // Build dynamic WHERE clause
    const conditions = ['s.is_deleted = false'];
    const values = [];

    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      values.push(status);
      conditions.push(`s.status = $${values.length}`);
    }

    if (search.trim()) {
      values.push(`%${search.trim()}%`);
      conditions.push(`(s.title ILIKE $${values.length} OR u.name ILIKE $${values.length})`);
    }

    const whereClause = conditions.join(' AND ');

    const startups = await db.query(
      `SELECT s.*, u.name AS student_name, u.email AS student_email
       FROM startups s
       JOIN users u ON u.id = s.student_id
       WHERE ${whereClause}
       ORDER BY s.created_at DESC`,
      values
    );

    res.render('admin/startups', {
      title: 'Manage Startups',
      startups: startups.rows,
      filters: { search, status }   // ← view uses filters.search, filters.status
    });
  } catch (err) {
    console.error('Admin startups error:', err);
    req.flash('error', 'Error loading startups.');
    res.redirect('/admin/dashboard');
  }
});

// ── GET /admin/startup/:id ───────────────────────────────────────
// startup-detail.ejs expects:
//   startup, mentors[], assignedMentors[], progress[], feedback[], funding[]
router.get('/startup/:id', requireAdmin, async (req, res) => {
  try {
    const startupResult = await db.query(
      `SELECT s.*, u.name AS student_name, u.email AS student_email
       FROM startups s
       JOIN users u ON u.id = s.student_id
       WHERE s.id = $1 AND s.is_deleted = false`,
      [req.params.id]
    );

    if (!startupResult.rows[0]) {
      req.flash('error', 'Startup not found.');
      return res.redirect('/admin/startups');
    }

    const [mentors, assignedMentors, progress, feedback, funding] = await Promise.all([
      db.query("SELECT id, name, email FROM users WHERE role = 'mentor' ORDER BY name"),
      db.query(
        `SELECT u.id, u.name, u.email
         FROM mentor_assignments ma
         JOIN users u ON u.id = ma.mentor_id
         WHERE ma.startup_id = $1`,
        [req.params.id]
      ),
      db.query(
        `SELECT pu.*, u.name AS author_name
         FROM progress_updates pu
         JOIN users u ON u.id = pu.author_id
         WHERE pu.startup_id = $1
         ORDER BY pu.created_at DESC`,
        [req.params.id]
      ),
      db.query(
        `SELECT mf.*, u.name AS mentor_name
         FROM mentor_feedback mf
         JOIN users u ON u.id = mf.mentor_id
         WHERE mf.startup_id = $1
         ORDER BY mf.created_at DESC`,
        [req.params.id]
      ),
      db.query(
        `SELECT * FROM funding_requests
         WHERE startup_id = $1
         ORDER BY created_at DESC`,
        [req.params.id]
      )
    ]);

    res.render('admin/startup-detail', {
      title:           startupResult.rows[0].title,
      startup:         startupResult.rows[0],
      mentors:         mentors.rows,
      assignedMentors: assignedMentors.rows,
      progress:        progress.rows,
      feedback:        feedback.rows,
      funding:         funding.rows
    });
  } catch (err) {
    console.error('Admin startup detail error:', err);
    req.flash('error', 'Error loading startup.');
    res.redirect('/admin/startups');
  }
});

// ── POST /admin/startup/:id/status ──────────────────────────────
router.post('/startup/:id/status', requireAdmin, async (req, res) => {
  const { status, admin_remark } = req.body;

  if (!['approved', 'rejected'].includes(status)) {
    req.flash('error', 'Invalid status.');
    return res.redirect(`/admin/startup/${req.params.id}`);
  }

  try {
    // FOR UPDATE serialises concurrent requests (e.g. a double-click on Approve): the
    // second one sees the already-changed status and therefore does not notify again.
    const result = await db.query(
      `WITH prev AS (
         SELECT id, status FROM startups WHERE id = $3 AND is_deleted = false FOR UPDATE
       )
       UPDATE startups s
       SET status = $1, admin_remark = $2, updated_at = NOW()
       FROM prev WHERE s.id = prev.id
       RETURNING s.id, prev.status AS previous_status`,
      [status, admin_remark || null, req.params.id]
    );

    if (!result.rows[0]) {
      req.flash('error', 'Startup not found.');
      return res.redirect('/admin/startups');
    }

    const changed = result.rows[0].previous_status !== status;
    await audit(req, `STARTUP_${status.toUpperCase()}`, 'startup', result.rows[0].id,
                { details: { from: result.rows[0].previous_status, changed } });
    if (changed) await notificationService.startupReviewed(result.rows[0].id);

    req.flash('success', changed ? `Startup ${status} successfully.` : `Startup was already ${status}. Remark saved.`);
    res.redirect('/admin/startups');
  } catch (err) {
    console.error('Status update error:', err);
    await audit(req, `STARTUP_${status.toUpperCase()}`, 'startup', Number(req.params.id) || null, { result: 'failure', details: { error: err.message } });
    req.flash('error', 'Failed to update status.');
    res.redirect(`/admin/startup/${req.params.id}`);
  }
});

// ── POST /admin/startup/:id/assign-mentor ───────────────────────
router.post('/startup/:id/assign-mentor', requireAdmin, async (req, res) => {
  const { mentor_id } = req.body;

  if (!mentor_id) {
    req.flash('error', 'Please select a mentor.');
    return res.redirect(`/admin/startup/${req.params.id}`);
  }

  try {
    const inserted = await db.query(
      `INSERT INTO mentor_assignments (startup_id, mentor_id)
       SELECT s.id, u.id FROM startups s, users u
       WHERE s.id = $1 AND s.is_deleted = false AND u.id = $2 AND u.role = 'mentor'
       ON CONFLICT (startup_id, mentor_id) DO NOTHING
       RETURNING id`,
      [req.params.id, mentor_id]
    );

    if (!inserted.rows[0]) {
      req.flash('error', 'That mentor is already assigned, or is not a valid mentor.');
      return res.redirect(`/admin/startup/${req.params.id}`);
    }

    await audit(req, 'MENTOR_ASSIGNED', 'startup', Number(req.params.id), { details: { mentorId: Number(mentor_id) } });
    await notificationService.mentorAssigned(inserted.rows[0].id);
    req.flash('success', 'Mentor assigned successfully.');
    res.redirect(`/admin/startup/${req.params.id}`);
  } catch (err) {
    console.error('Assign mentor error:', err);
    await audit(req, 'MENTOR_ASSIGNED', 'startup', Number(req.params.id) || null, { result: 'failure', details: { error: err.message } });
    req.flash('error', 'Failed to assign mentor.');
    res.redirect(`/admin/startup/${req.params.id}`);
  }
});

// ── POST /admin/startup/:id/remove-mentor/:mentorId ─────────────
router.post('/startup/:id/remove-mentor/:mentorId', requireAdmin, async (req, res) => {
  try {
    const removed = await db.query(
      `DELETE FROM mentor_assignments
       WHERE startup_id = $1 AND mentor_id = $2
       RETURNING id`,
      [req.params.id, req.params.mentorId]
    );
    if (removed.rows[0]) {
      await audit(req, 'MENTOR_REMOVED', 'startup', Number(req.params.id), { details: { mentorId: Number(req.params.mentorId) } });
      await notificationService.mentorRemoved({ startupId: req.params.id, mentorId: req.params.mentorId });
    }
    req.flash('success', 'Mentor removed.');
    res.redirect(`/admin/startup/${req.params.id}`);
  } catch (err) {
    console.error('Remove mentor error:', err);
    req.flash('error', 'Failed to remove mentor.');
    res.redirect(`/admin/startup/${req.params.id}`);
  }
});

// ── GET /admin/funding ───────────────────────────────────────────
// funding.ejs expects: requests[] with startup_title, student_name
router.get('/funding', requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT fr.*,
              s.title AS startup_title,
              u.name  AS student_name,
              u.email AS student_email
       FROM funding_requests fr
       JOIN startups s ON s.id = fr.startup_id
       JOIN users u    ON u.id = s.student_id
       WHERE s.is_deleted = false
       ORDER BY fr.created_at DESC`
    );

    res.render('admin/funding', {
      title:    'Funding Requests',
      requests: result.rows
    });
  } catch (err) {
    console.error('Admin funding error:', err);
    req.flash('error', 'Error loading funding requests.');
    res.redirect('/admin/dashboard');
  }
});

// ── POST /admin/funding/:id/status ──────────────────────────────
router.post('/funding/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;

  if (!['approved', 'rejected'].includes(status)) {
    req.flash('error', 'Invalid status.');
    return res.redirect('/admin/funding');
  }

  try {
    const result = await db.query(
      `WITH prev AS (SELECT id, status FROM funding_requests WHERE id = $2 FOR UPDATE)
       UPDATE funding_requests fr
       SET status = $1, updated_at = NOW()
       FROM prev WHERE fr.id = prev.id
       RETURNING fr.id, prev.status AS previous_status`,
      [status, req.params.id]
    );

    if (!result.rows[0]) {
      req.flash('error', 'Funding request not found.');
      return res.redirect('/admin/funding');
    }

    const changed = result.rows[0].previous_status !== status;
    await audit(req, `FUNDING_${status.toUpperCase()}`, 'funding', result.rows[0].id,
                { details: { from: result.rows[0].previous_status, changed } });
    if (changed) await notificationService.fundingReviewed(result.rows[0].id);

    req.flash('success', changed ? `Funding request ${status}.` : `Funding request was already ${status}.`);
    res.redirect('/admin/funding');
  } catch (err) {
    console.error('Funding status error:', err);
    await audit(req, `FUNDING_${status.toUpperCase()}`, 'funding', Number(req.params.id) || null, { result: 'failure', details: { error: err.message } });
    req.flash('error', 'Failed to update funding request.');
    res.redirect('/admin/funding');
  }
});

// ── GET /admin/users ─────────────────────────────────────────────
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await db.query(
      `SELECT id, name, email, role, auth_provider, is_profile_complete, created_at
       FROM users
       ORDER BY created_at DESC`
    );
    res.render('admin/users', {
      title: 'Manage Users',
      users: users.rows
    });
  } catch (err) {
    console.error('Admin users error:', err);
    req.flash('error', 'Error loading users.');
    res.redirect('/admin/dashboard');
  }
});

// ── POST /admin/users/:id/role ───────────────────────────────────
router.post('/users/:id/role', requireAdmin, async (req, res) => {
  const { role } = req.body;
  const { id } = req.params;

  if (!['student', 'mentor', 'admin'].includes(role)) {
    req.flash('error', 'Invalid role selected.');
    return res.redirect('/admin/users');
  }

  if (parseInt(id) === req.user.id) {
    req.flash('error', 'You cannot change your own role.');
    return res.redirect('/admin/users');
  }

  try {
    const result = await db.query(
      `UPDATE users u SET role = $1, is_profile_complete = true
       FROM (SELECT id, role FROM users WHERE id = $2 FOR UPDATE) o
       WHERE u.id = o.id
       RETURNING o.role AS old_role`,
      [role, id]
    );

    if (!result.rows[0]) {
      req.flash('error', 'User not found.');
      return res.redirect('/admin/users');
    }

    const oldRole = result.rows[0].old_role;
    await audit(req, 'USER_ROLE_CHANGED', 'user', Number(id), { details: { from: oldRole, to: role } });
    await notificationService.userRoleChanged({ userId: Number(id), oldRole, newRole: role });
    req.flash('success', 'User role updated successfully.');
    res.redirect('/admin/users');
  } catch (err) {
    console.error('Role change error:', err);
    await audit(req, 'USER_ROLE_CHANGED', 'user', Number(id) || null, { result: 'failure', details: { error: err.message } });
    req.flash('error', 'Failed to update role.');
    res.redirect('/admin/users');
  }
});

// ── GET /admin/email-logs ────────────────────────────────────────
// Metadata only: bodies and reset links are never stored, so nothing sensitive can leak here.
router.get('/email-logs', requireAdmin, async (req, res) => {
  try {
    const { status = '', template = '', q = '', from = '', to = '' } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const PAGE = 25;

    const where = [];
    const values = [];
    const add = (sql, v) => { values.push(v); where.push(sql.replace('?', `$${values.length}`)); };

    if (['sent', 'failed', 'queued'].includes(status)) add('el.status = ?', status);
    if (TEMPLATE_KEYS.includes(template))              add('el.template = ?', template);
    if (q.trim())                                      add('el.recipient ILIKE ?', `%${q.trim()}%`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(from))              add('el.created_at >= ?::date', from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to))                add("el.created_at < (?::date + INTERVAL '1 day')", to);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows, total, counts] = await Promise.all([
      db.query(
        `SELECT el.*, s.id AS startup_id, s.title AS startup_title
         FROM email_logs el
         LEFT JOIN funding_requests fr ON el.related_entity_type = 'funding' AND fr.id = el.related_entity_id
         LEFT JOIN startups s ON s.id = CASE WHEN el.related_entity_type = 'startup' THEN el.related_entity_id
                                             WHEN el.related_entity_type = 'funding' THEN fr.startup_id END
         ${whereSql}
         ORDER BY el.created_at DESC, el.id DESC
         LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`, values),
      db.query(`SELECT COUNT(*)::int AS n FROM email_logs el ${whereSql}`, values),
      db.query(`SELECT status, COUNT(*)::int AS n FROM email_logs GROUP BY status`)
    ]);

    const counter = { sent: 0, failed: 0, queued: 0 };
    counts.rows.forEach(r => { counter[r.status] = r.n; });

    res.render('admin/email-logs', {
      title: 'Email Activity',
      logs: rows.rows,
      total: total.rows[0].n,
      page, pages: Math.max(1, Math.ceil(total.rows[0].n / PAGE)),
      counter, templates: TEMPLATE_KEYS,
      filters: { status, template, q, from, to }
    });
  } catch (err) {
    console.error('Email logs error:', err);
    req.flash('error', 'Error loading email activity.');
    res.redirect('/admin/dashboard');
  }
});

export default router;