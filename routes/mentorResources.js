/** Mentor visibility into resources their assigned startups are using. Read-only:
 *  no approve/issue/edit actions live here (Rule 9 — mentors get context, not control). */
import express from 'express';
import { requireMentor } from '../middleware/authMiddleware.js';
import * as Q from '../service/resourceQueries.js';

const router = express.Router();
router.use(requireMentor);

const label = (s) => (s ? String(s).charAt(0) + String(s).slice(1).toLowerCase().replace(/_/g, ' ') : '');
router.get('/', async (req, res) => {
  try {
    const data = await Q.mentorResources(req.user.id);
    res.render('mentor/resources', {
      title: 'Startup Resources', ...data,
      h: { label, date: (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'),
           badge: (s) => `<span class="badge rs-${String(s).toLowerCase()}">${label(s)}</span>` }
    });
  } catch (err) { console.error(err); req.flash('error', 'Could not load resources.'); res.redirect('/mentor/dashboard'); }
});
export default router;
