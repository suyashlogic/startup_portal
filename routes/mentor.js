import express from "express";
import db from '../config/db.js';
import { requireMentor } from '../middleware/authMiddleware.js';
import notificationService from '../service/notificationService.js';
import { audit } from '../service/auditService.js';

const router = express.Router();

// ── GET /mentor/dashboard 
router.get('/dashboard', requireMentor, async (req, res) => {
  try {
    const startups = await db.query(
      `SELECT
         s.*,
         u.name  AS student_name,
         u.email AS student_email,
         -- feedback_count: how many feedback entries exist for this startup
         (SELECT COUNT(*) FROM mentor_feedback mf WHERE mf.startup_id = s.id)::int AS feedback_count,
         -- progress_count: how many progress updates exist for this startup
         (SELECT COUNT(*) FROM progress_updates pu WHERE pu.startup_id = s.id)::int AS progress_count
       FROM mentor_assignments ma
       JOIN startups s ON s.id  = ma.startup_id
       JOIN users u    ON u.id  = s.student_id
       WHERE ma.mentor_id = $1 AND s.is_deleted = false
       ORDER BY ma.assigned_at DESC`,
      [req.user.id]
    );

    res.render('mentor/dashboard', {
      title: 'Mentor Dashboard',
      startups: startups.rows
    });
  } catch (err) {
    console.error('Mentor dashboard error:', err);
    req.flash('error', 'Error loading dashboard.');
    res.redirect('/');
  }
});

// ── GET /mentor/feedback ─────────────────────────────────────────
// all-feedback.ejs expects:
//   feedback[]  (with startup_id, startup_title, startup_status, domain,
//                student_name, mentor_name, feedback, created_at)
router.get('/feedback', requireMentor, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         mf.id,
         mf.feedback,
         mf.created_at,
         mf.startup_id,
         s.title        AS startup_title,
         s.status       AS startup_status,
         s.domain,
         u.name         AS student_name
       FROM mentor_feedback mf
       JOIN startups s ON s.id  = mf.startup_id
       JOIN users    u ON u.id  = s.student_id
       WHERE mf.mentor_id = $1
         AND s.is_deleted = false
       ORDER BY mf.created_at DESC`,
      [req.user.id]
    );

    res.render('mentor/feedback', {
      title:    'All Feedback',
      feedback: result.rows
    });
  } catch (err) {
    console.error('All feedback error:', err);
    req.flash('error', 'Could not load feedback history.');
    res.redirect('/mentor/dashboard');
  }
});

// ── GET /mentor/startup/:id ──────────────────────────────────────
// startup-detail.ejs expects:
//   startup  (with student_name, student_email)
//   progress[]  (with author_name)
//   feedback[]  (with mentor_name)
//   user  ← already in res.locals via setLocals, but confirming it's available
router.get('/startup/:id', requireMentor, async (req, res) => {
  try {
    // Guard — mentor must be assigned to this startup
    const assignment = await db.query(
      `SELECT * FROM mentor_assignments
       WHERE startup_id = $1 AND mentor_id = $2`,
      [req.params.id, req.user.id]
    );

    if (!assignment.rows[0]) {
      req.flash('error', 'You are not assigned to this startup.');
      return res.redirect('/mentor/dashboard');
    }

    const startupResult = await db.query(
      `SELECT s.*, u.name AS student_name, u.email AS student_email
       FROM startups s
       JOIN users u ON u.id = s.student_id
       WHERE s.id = $1 AND s.is_deleted = false`,
      [req.params.id]
    );

    if (!startupResult.rows[0]) {
      req.flash('error', 'Startup not found.');
      return res.redirect('/mentor/dashboard');
    }

    // Run progress + feedback queries in parallel
    const [progressResult, feedbackResult] = await Promise.all([
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
      )
    ]);

    res.render('mentor/startup-detail', {
      title:    startupResult.rows[0].title,
      startup:  startupResult.rows[0],
      progress: progressResult.rows,
      feedback: feedbackResult.rows
      // Note: `user` is already available in all views via res.locals.user (set by setLocals middleware)
      // The view uses `user.name` to highlight "You" badge on feedback — this works automatically
    });
  } catch (err) {
    console.error('Mentor startup detail error:', err);
    req.flash('error', 'Error loading startup.');
    res.redirect('/mentor/dashboard');
  }
});

// ── POST /mentor/startup/:id/feedback ───────────────────────────
router.post('/startup/:id/feedback', requireMentor, async (req, res) => {
  const { feedback } = req.body;
  const { id } = req.params;

  if (!feedback || !feedback.trim()) {
    req.flash('error', 'Feedback cannot be empty.');
    return res.redirect(`/mentor/startup/${id}`);
  }

  try {
    // Guard — mentor must be assigned
    const assignment = await db.query(
      `SELECT * FROM mentor_assignments
       WHERE startup_id = $1 AND mentor_id = $2`,
      [id, req.user.id]
    );

    if (!assignment.rows[0]) {
      req.flash('error', 'You are not assigned to this startup.');
      return res.redirect('/mentor/dashboard');
    }

    const inserted = await db.query(
      `INSERT INTO mentor_feedback (startup_id, mentor_id, feedback)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [id, req.user.id, feedback.trim()]
    );
    await audit(req, 'FEEDBACK_SUBMITTED', 'startup', Number(id), { details: { feedbackId: inserted.rows[0].id } });
    await notificationService.mentorFeedbackAdded(inserted.rows[0].id);

    req.flash('success', 'Feedback submitted successfully!');
    res.redirect(`/mentor/startup/${id}`);
  } catch (err) {
    console.error('Mentor feedback error:', err);
    req.flash('error', 'Failed to submit feedback.');
    res.redirect(`/mentor/startup/${id}`);
  }
});

export default router;