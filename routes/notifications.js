import express from 'express';
import { requireCompleteProfile } from '../middleware/authMiddleware.js';
import { CATEGORIES } from '../service/emailTemplates.js';
import {
  listNotifications, unreadCount, markRead, markAllRead, getPreferences, setPreferences,
} from '../service/notificationStore.js';

const router = express.Router();
router.use(requireCompleteProfile);

const wantsJson = (req) => (req.get('accept') || '').includes('application/json');
const PAGE_SIZE = 15;

// ── GET /notifications ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const unreadOnly = req.query.filter === 'unread';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const { items, total } = await listNotifications(req.user.id, {
      limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, unreadOnly,
    });
    res.render('notifications/index', {
      title: 'Notifications', items, total, page, unreadOnly,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    });
  } catch (err) {
    console.error('Notifications page error:', err);
    req.flash('error', 'Could not load notifications.');
    res.redirect(`/${req.user.role}/dashboard`);
  }
});

// ── GET /notifications/recent (JSON for the bell dropdown) ─────────────────
router.get('/recent', async (req, res) => {
  try {
    const [{ items }, unread] = await Promise.all([
      listNotifications(req.user.id, { limit: 6 }), unreadCount(req.user.id),
    ]);
    res.json({
      unread,
      items: items.map((n) => ({ id: n.id, type: n.type, title: n.title, message: n.message, link: n.link, is_read: n.is_read, created_at: n.created_at })),
    });
  } catch (err) {
    console.error('Notifications recent error:', err);
    res.status(500).json({ error: 'Could not load notifications.' });
  }
});

// ── POST /notifications/read-all ───────────────────────────────────────────
router.post('/read-all', async (req, res) => {
  try {
    await markAllRead(req.user.id);
    if (wantsJson(req)) return res.json({ ok: true, unread: 0 });
    req.flash('success', 'All notifications marked as read.');
  } catch (err) {
    console.error('Mark all read error:', err);
    if (wantsJson(req)) return res.status(500).json({ ok: false });
    req.flash('error', 'Could not update notifications.');
  }
  res.redirect('/notifications');
});

// ── GET/POST /notifications/preferences ────────────────────────────────────
router.get('/preferences', async (req, res) => {
  try {
    res.render('notifications/preferences', {
      title: 'Email Preferences', categories: CATEGORIES, prefs: await getPreferences(req.user.id),
    });
  } catch (err) {
    console.error('Preferences load error:', err);
    req.flash('error', 'Could not load preferences.');
    res.redirect('/notifications');
  }
});

router.post('/preferences', async (req, res) => {
  try {
    // Checkbox semantics: present = on, absent = off. Only known, non-mandatory keys are honoured.
    const map = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, req.body[k] === 'on']));
    await setPreferences(req.user.id, map);
    req.flash('success', 'Email preferences saved.');
  } catch (err) {
    console.error('Preferences save error:', err);
    req.flash('error', 'Could not save preferences.');
  }
  res.redirect('/notifications/preferences');
});

// ── POST /notifications/:id/read ───────────────────────────────────────────
// Scoped by user_id in SQL: someone else's notification simply matches nothing.
router.post('/:id(\\d+)/read', async (req, res) => {
  try {
    const n = await markRead(req.user.id, parseInt(req.params.id, 10));
    if (wantsJson(req)) return n ? res.json({ ok: true }) : res.status(404).json({ ok: false });
    if (!n) { req.flash('error', 'Notification not found.'); return res.redirect('/notifications'); }
    return res.redirect(n.link || '/notifications');
  } catch (err) {
    console.error('Mark read error:', err);
    if (wantsJson(req)) return res.status(500).json({ ok: false });
    req.flash('error', 'Could not update notification.');
    res.redirect('/notifications');
  }
});

export default router;
