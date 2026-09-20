/**
 * notificationStore: DB access for in-app notifications and email preferences.
 * Every read/write is scoped by user_id, so one user can never touch another's rows.
 */
import db from '../config/db.js';
import { CATEGORIES } from './emailTemplates.js';

/** Insert one notification. Returns the row, or null if the dedupe key already exists. */
export async function createNotification({ userId, type, title, message, link = null, entityType = null, entityId = null, dedupeKey = null }) {
  const safeLink = link && link.startsWith('/') && !link.startsWith('//') ? link : null;
  const r = await db.query(
    `INSERT INTO notifications (user_id, type, title, message, link, entity_type, entity_id, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [userId, type, String(title).slice(0, 200), message, safeLink, entityType, entityId, dedupeKey]
  );
  return r.rows[0] || null;
}

export async function unreadCount(userId) {
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND is_read = FALSE`, [userId]);
  return r.rows[0].n;
}

export async function listNotifications(userId, { limit = 20, offset = 0, unreadOnly = false } = {}) {
  const where = unreadOnly ? 'AND is_read = FALSE' : '';
  const [rows, total] = await Promise.all([
    db.query(`SELECT * FROM notifications WHERE user_id = $1 ${where} ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
             [userId, limit, offset]),
    db.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 ${where}`, [userId]),
  ]);
  return { items: rows.rows, total: total.rows[0].n };
}

/** Returns the notification if it belongs to this user (and marks it read), else null. */
export async function markRead(userId, id) {
  const r = await db.query(
    `UPDATE notifications SET is_read = TRUE, read_at = COALESCE(read_at, NOW())
     WHERE id = $1 AND user_id = $2 RETURNING *`, [id, userId]);
  return r.rows[0] || null;
}

export async function markAllRead(userId) {
  const r = await db.query(
    `UPDATE notifications SET is_read = TRUE, read_at = NOW() WHERE user_id = $1 AND is_read = FALSE`, [userId]);
  return r.rowCount;
}

/** { category: boolean } for every known category (mandatory ones are always true). */
export async function getPreferences(userId) {
  const r = await db.query(`SELECT category, enabled FROM email_preferences WHERE user_id = $1`, [userId]);
  const stored = Object.fromEntries(r.rows.map((x) => [x.category, x.enabled]));
  return Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.mandatory ? true : stored[k] ?? true]));
}

/** `enabledMap` is { category: boolean }. Unknown and mandatory categories are ignored. */
export async function setPreferences(userId, enabledMap) {
  for (const [key, meta] of Object.entries(CATEGORIES)) {
    if (meta.mandatory || !(key in enabledMap)) continue;
    await db.query(
      `INSERT INTO email_preferences (user_id, category, enabled) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, category) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
      [userId, key, !!enabledMap[key]]);
  }
}

export async function emailEnabled(userId, category, mandatory) {
  if (mandatory || !userId) return true;
  const r = await db.query(`SELECT enabled FROM email_preferences WHERE user_id = $1 AND category = $2`, [userId, category]);
  return r.rows[0] ? r.rows[0].enabled : true;
}
