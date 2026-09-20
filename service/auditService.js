/**
 * auditService: append-only "who did what to which entity" trail.
 * Complements email_logs (which answers "did the email go out?").
 * Never throws: a failed audit write must not break the business action.
 */
import db from '../config/db.js';

/**
 * @param {object} req              Express request (actor = req.user, ip = req.ip)
 * @param {string} action           UPPER_SNAKE, e.g. 'STARTUP_APPROVED'
 * @param {string} entityType       'startup' | 'funding' | 'user' | ...
 * @param {number} entityId
 * @param {object} [opts]           { result: 'success'|'failure', details: {...}, actor: {id,name,role} }
 */
export async function audit(req, action, entityType, entityId, opts = {}) {
  try {
    const actor = opts.actor || req?.user || {};
    await db.query(
      `INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, entity_type, entity_id, result, details, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [actor.id ?? null, actor.name ?? null, actor.role ?? null, action, entityType ?? null, entityId ?? null,
       opts.result || 'success', opts.details ? JSON.stringify(opts.details) : null, req?.ip ?? null]);
  } catch (err) {
    console.error(`[audit] could not record ${action}:`, err.message);
  }
}

export async function recentActivity(limit = 8) {
  const r = await db.query(
    `SELECT action, entity_type, entity_id, actor_name, actor_role, result, created_at
     FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT $1`, [limit]);
  return r.rows;
}
