import express from "express";
import db from '../config/db.js';
import { upload, uploadProposal } from '../middleware/upload.js';
import { requireStudent } from '../middleware/authMiddleware.js';
import notificationService from '../service/notificationService.js';
import { audit } from '../service/auditService.js';
import fs from 'fs/promises';

const router = express.Router();

// Multer writes the file before our handler runs. If we then reject the request, don't leave it orphaned.
const discardUpload = (req) => (req.file ? fs.unlink(req.file.path).catch(() => {}) : Promise.resolve());

// Only the owning student may act on a startup. Returns the row or null.
async function ownedStartup(startupId, studentId) {
  if (!/^\d+$/.test(String(startupId))) return null;
  const r = await db.query(
    `SELECT id, status FROM startups WHERE id = $1 AND student_id = $2 AND is_deleted = false`,
    [startupId, studentId]
  );
  return r.rows[0] || null;
}

// ── GET /student/dashboard ───────────────────────────────────────
// dashboard.ejs expects: startups[], stats.{ total, pending, approved, rejected }
router.get('/dashboard', requireStudent, async (req, res) => {
  try {
    const startups = await db.query(
      `SELECT * FROM startups
       WHERE student_id = $1 AND is_deleted = false
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    const rows = startups.rows;
    const stats = {
      total:    rows.length,
      pending:  rows.filter(s => s.status === 'pending').length,
      approved: rows.filter(s => s.status === 'approved').length,
      rejected: rows.filter(s => s.status === 'rejected').length,
    };

    res.render('student/dashboard', {
      title: 'Student Dashboard',
      startups: rows,
      stats
    });
  } catch (err) {
    console.error('Student dashboard error:', err);
    req.flash('error', 'Could not load dashboard.');
    res.redirect('/');
  }
});

// ── GET /student/startups ────────────────────────────────────────
// my-startups.ejs expects: startups[] with feedback_count, progress_count,
//   admin_remark, pitch_deck_url, stage, status, domain, title, description
router.get('/startups', requireStudent, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         s.*,
         (SELECT COUNT(*) FROM mentor_feedback  mf WHERE mf.startup_id = s.id)::int AS feedback_count,
         (SELECT COUNT(*) FROM progress_updates pu WHERE pu.startup_id = s.id)::int AS progress_count
       FROM startups s
       WHERE s.student_id = $1 AND s.is_deleted = false
       ORDER BY s.created_at DESC`,
      [req.user.id]
    );

    res.render('student/my-startups', {
      title: 'My Startups',
      startups: result.rows
    });
  } catch (err) {
    console.error('My startups error:', err);
    req.flash('error', 'Could not load your startups.');
    res.redirect('/student/dashboard');
  }
});

// ── GET /student/startup/new ─────────────────────────────────────
// submit-startup.ejs — no extra vars needed
router.get('/startup/new', requireStudent, (req, res) => {
  res.render('student/submit-startup', { title: 'Submit Startup Idea' });
});

// ── POST /student/startup/new ────────────────────────────────────
// submit-startup.ejs posts: title, description, domain, stage, pitch_deck (file)
router.post('/startup/new', requireStudent, upload.single('pitch_deck'), async (req, res) => {
  const { title, description, domain, stage } = req.body;

  if (!title || !description || !domain || !stage) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/student/startup/new');
  }

  const validStages = ['idea', 'prototype', 'mvp', 'scaling'];
  if (!validStages.includes(stage)) {
    req.flash('error', 'Invalid stage selected.');
    return res.redirect('/student/startup/new');
  }

  try {
    const pitchDeckUrl = req.file ? '/uploads/' + req.file.filename : null;

    const inserted = await db.query(
      `INSERT INTO startups (title, description, domain, stage, pitch_deck_url, student_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [title, description, domain, stage, pitchDeckUrl, req.user.id]
    );

    const startupId = inserted.rows[0].id;
    await audit(req, 'STARTUP_SUBMITTED', 'startup', startupId);
    await notificationService.startupSubmitted(startupId);

    req.flash('success', 'Startup submitted! Admin will review it soon.');
    res.redirect('/student/dashboard');
  } catch (err) {
    if (err.code === '23505') {
      req.flash('error', 'You already have a startup with this title.');
    } else {
      console.error('Submit startup error:', err);
      req.flash('error', 'Failed to submit. Please try again.');
    }
    res.redirect('/student/startup/new');
  }
});

// ── GET /student/startup/:id ─────────────────────────────────────
// startup-detail.ejs expects:
//   startup, mentors[], progress[], feedback[], funding[]
router.get('/startup/:id', requireStudent, async (req, res) => {
  try {
    const startupResult = await db.query(
      `SELECT * FROM startups
       WHERE id = $1 AND student_id = $2 AND is_deleted = false`,
      [req.params.id, req.user.id]
    );

    if (!startupResult.rows[0]) {
      req.flash('error', 'Startup not found.');
      return res.redirect('/student/dashboard');
    }

    const startup = startupResult.rows[0];

    const [mentorsResult, progressResult, feedbackResult, fundingResult] = await Promise.all([
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

    res.render('student/startup-detail', {
      title:    startup.title,
      startup,
      mentors:  mentorsResult.rows,
      progress: progressResult.rows,
      feedback: feedbackResult.rows,
      funding:  fundingResult.rows
    });
  } catch (err) {
    console.error('Startup detail error:', err);
    req.flash('error', 'Error loading startup. Please try again later.');
    res.redirect('/student/dashboard');
  }
});

// ── POST /student/startup/:id/progress ──────────────────────────
router.post('/startup/:id/progress', requireStudent, async (req, res) => {
  const { description } = req.body;
  const { id } = req.params;

  if (!description || !description.trim()) {
    req.flash('error', 'Progress description cannot be empty.');
    return res.redirect(`/student/startup/${id}`);
  }

  try {
    if (!(await ownedStartup(id, req.user.id))) {
      req.flash('error', 'Startup not found.');
      return res.redirect('/student/dashboard');
    }

    const inserted = await db.query(
      `INSERT INTO progress_updates (startup_id, author_id, description)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [id, req.user.id, description.trim()]
    );
    await audit(req, 'PROGRESS_POSTED', 'startup', Number(id), { details: { updateId: inserted.rows[0].id } });
    await notificationService.progressUpdateAdded(inserted.rows[0].id);
    req.flash('success', 'Progress update added!');
    res.redirect(`/student/startup/${id}`);
  } catch (err) {
    console.error('Progress update error:', err);
    req.flash('error', 'Failed to add progress update.');
    res.redirect(`/student/startup/${id}`);
  }
});

// ── POST /student/startup/:id/funding ───────────────────────────
// Uses uploadProposal (accepts PDF, DOC, DOCX, PPT, PPTX, JPG, PNG, WEBP)
router.post('/startup/:id/funding', requireStudent, uploadProposal.single('proposal'), async (req, res) => {
  const { amount, purpose } = req.body;
  const { id } = req.params;

  if (!amount || !purpose) {
    await discardUpload(req);
    req.flash('error', 'Amount and purpose are required.');
    return res.redirect(`/student/startup/${id}`);
  }

  if (isNaN(amount) || Number(amount) <= 0) {
    await discardUpload(req);
    req.flash('error', 'Please enter a valid amount.');
    return res.redirect(`/student/startup/${id}`);
  }

  try {
    // Ownership + "approved only" are enforced here, not just hidden in the UI.
    const startup = await ownedStartup(id, req.user.id);
    if (!startup) {
      await discardUpload(req);
      req.flash('error', 'Startup not found.');
      return res.redirect('/student/dashboard');
    }
    if (startup.status !== 'approved') {
      await discardUpload(req);
      req.flash('error', 'Funding can only be requested after your startup is approved.');
      return res.redirect(`/student/startup/${id}`);
    }

    const proposalFile = req.file ? '/uploads/' + req.file.filename : null;

    const inserted = await db.query(
      `INSERT INTO funding_requests (startup_id, amount_requested, purpose, proposal_file)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [id, amount, purpose.trim(), proposalFile]
    );
    const fundingId = inserted.rows[0].id;
    await audit(req, 'FUNDING_REQUESTED', 'funding', fundingId, { details: { startupId: Number(id), amount: Number(amount) } });
    await notificationService.fundingSubmitted(fundingId);
    req.flash('success', 'Funding request submitted!');
    res.redirect(`/student/startup/${id}`);
  } catch (err) {
    console.error('Funding request error:', err);
    req.flash('error', 'Failed to submit funding request.');
    res.redirect(`/student/startup/${id}`);
  }
});

export default router;