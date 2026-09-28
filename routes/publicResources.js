/**
 * Public QR-scan target. No auth — this is what a printed label on a shelf
 * links to. Deliberately shows only what's safe for anyone to see (name,
 * code, category, location, status): no purchase cost, no student names, no
 * internal notes. "Report an issue" sends an unauthenticated visitor to log
 * in first, via the existing requireStudent guard on that route.
 */
import express from 'express';
import * as Q from '../service/resourceQueries.js';

const router = express.Router();

router.get('/:code', async (req, res) => {
  try {
    const resource = await Q.getResourceByCode(req.params.code);
    if (!resource) {
      return res.status(404).render('public/resource-not-found', { title: 'Not Found', code: req.params.code });
    }
    res.render('public/resource', { title: resource.name, resource });
  } catch (err) {
    console.error('Public resource page error:', err);
    res.status(500).render('public/resource-not-found', { title: 'Error', code: req.params.code });
  }
});

export default router;
