/** Read-only queries for resource screens. All parameterised; sort columns are whitelisted. */
import db from '../config/db.js';

export const PAGE_SIZE = 15;
const SORTS = { name: 'LOWER(r.name)', created: 'r.created_at DESC', status: 'r.status', code: 'r.asset_code' };
const OPEN = `('ACTIVE','RETURN_REQUESTED','OVERDUE')`;

export async function categories(activeOnly = false) {
  const r = await db.query(
    `SELECT c.*, COUNT(r.id) FILTER (WHERE r.is_active)::int AS resource_count
     FROM resource_categories c LEFT JOIN resources r ON r.category_id = c.id
     ${activeOnly ? 'WHERE c.is_active' : ''} GROUP BY c.id ORDER BY LOWER(c.name)`);
  return r.rows;
}

export async function listResources(f) {
  const where = [f.inactive ? 'NOT r.is_active' : 'r.is_active'], v = [];
  const add = (sql, val) => { v.push(val); where.push(sql.replace('?', `$${v.length}`)); };
  if (f.q) add(`(r.asset_code ILIKE ? OR r.name ILIKE ? OR r.serial_number ILIKE ? OR r.brand ILIKE ? OR r.model ILIKE ?)`.replace(/\?/g, '$' + (v.length + 1)), `%${f.q}%`);
  if (/^\d+$/.test(f.category || '')) add('r.category_id = ?', +f.category);
  if (f.status)    add('r.status = ?', f.status);
  if (f.type)      add('r.resource_type = ?', f.type);
  if (f.condition) add('r.condition = ?', f.condition);
  if (f.location)  add('r.location ILIKE ?', `%${f.location}%`);
  const W = where.join(' AND ');
  const page = Math.max(1, parseInt(f.page, 10) || 1);
  const order = SORTS[f.sort] || SORTS.created;
  const [rows, total] = await Promise.all([
    db.query(
      `SELECT r.*, c.name AS category_name,
         (SELECT string_agg(u.name, ', ') FROM resource_assignments a JOIN users u ON u.id = a.user_id
           WHERE a.resource_id = r.id AND a.status IN ${OPEN}) AS assigned_to
       FROM resources r JOIN resource_categories c ON c.id = r.category_id
       WHERE ${W} ORDER BY ${order}, r.id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, v),
    db.query(`SELECT COUNT(*)::int AS n FROM resources r WHERE ${W}`, v)
  ]);
  return { rows: rows.rows, total: total.rows[0].n, page, pages: Math.max(1, Math.ceil(total.rows[0].n / PAGE_SIZE)) };
}

export async function getResource(id) {
  const r = await db.query(
    `SELECT r.*, c.name AS category_name, cu.name AS created_by_name FROM resources r
     JOIN resource_categories c ON c.id = r.category_id LEFT JOIN users cu ON cu.id = r.created_by WHERE r.id = $1`, [id]);
  return r.rows[0] || null;
}

export async function resourceDetailExtras(id) {
  const [assign, maint, issues] = await Promise.all([
    db.query(`SELECT a.*, u.name AS user_name, s.title AS startup_title FROM resource_assignments a
              JOIN users u ON u.id = a.user_id LEFT JOIN startups s ON s.id = a.startup_id
              WHERE a.resource_id = $1 ORDER BY a.issued_at DESC LIMIT 20`, [id]),
    db.query(`SELECT * FROM resource_maintenance WHERE resource_id = $1 ORDER BY start_date DESC LIMIT 20`, [id]),
    db.query(`SELECT i.*, u.name AS reporter FROM resource_issues i LEFT JOIN users u ON u.id = i.reported_by
              WHERE i.resource_id = $1 ORDER BY i.created_at DESC LIMIT 20`, [id])
  ]);
  return { assignments: assign.rows, maintenance: maint.rows, issues: issues.rows };
}

export async function listRequests(status) {
  const ok = ['PENDING', 'APPROVED', 'REJECTED', 'ISSUED', 'COMPLETED', 'CANCELLED'].includes(status);
  const r = await db.query(
    `SELECT q.*, r.name AS resource_name, r.asset_code, r.quantity AS stock, u.name AS student_name, s.title AS startup_title
     FROM resource_requests q JOIN resources r ON r.id = q.resource_id JOIN users u ON u.id = q.user_id
     LEFT JOIN startups s ON s.id = q.startup_id ${ok ? 'WHERE q.status = $1' : ''}
     ORDER BY q.created_at DESC LIMIT 200`, ok ? [status] : []);
  const counts = await db.query(`SELECT status, COUNT(*)::int AS n FROM resource_requests GROUP BY status`);
  return { rows: r.rows, counts: Object.fromEntries(counts.rows.map((x) => [x.status, x.n])) };
}

export async function listAssignments(view) {
  const where = { open: `a.status IN ${OPEN}`, overdue: `(a.status = 'OVERDUE' OR (a.status IN ('ACTIVE','RETURN_REQUESTED') AND a.expected_return_at < NOW()))`,
                  returned: `a.status IN ('RETURNED','DAMAGED','LOST')`, all: 'TRUE' }[view] || `a.status IN ${OPEN}`;
  const r = await db.query(
    `SELECT a.*, r.name AS resource_name, r.asset_code, u.name AS student_name, s.title AS startup_title,
            GREATEST(0, CURRENT_DATE - a.expected_return_at::date) AS days_overdue
     FROM resource_assignments a JOIN resources r ON r.id = a.resource_id JOIN users u ON u.id = a.user_id
     LEFT JOIN startups s ON s.id = a.startup_id WHERE ${where} ORDER BY a.expected_return_at LIMIT 200`);
  return r.rows;
}

export async function overview(warrantyDays = 30) {
  const q = (sql, p = []) => db.query(sql, p).then((r) => r.rows);
  const [st, od, odList, cost, warranty, used, costly, byCat, pend, pendB, openI] = await Promise.all([
    q(`SELECT status, COUNT(*)::int AS n FROM resources WHERE is_active GROUP BY status`),
    q(`SELECT COUNT(*)::int AS n FROM resource_assignments WHERE status = 'OVERDUE' OR (status IN ('ACTIVE','RETURN_REQUESTED') AND expected_return_at < NOW())`),
    q(`SELECT a.id, u.name AS student_name, r.name AS resource_name, r.asset_code, a.issued_at, a.expected_return_at,
              GREATEST(1, CURRENT_DATE - a.expected_return_at::date) AS days_overdue
       FROM resource_assignments a JOIN users u ON u.id = a.user_id JOIN resources r ON r.id = a.resource_id
       WHERE a.status = 'OVERDUE' OR (a.status IN ('ACTIVE','RETURN_REQUESTED') AND a.expected_return_at < NOW())
       ORDER BY a.expected_return_at LIMIT 5`),
    q(`SELECT COALESCE(SUM(cost),0)::float AS total FROM resource_maintenance
       WHERE status = 'COMPLETED' AND date_trunc('month', completion_date) = date_trunc('month', CURRENT_DATE)`),
    q(`SELECT id, name, asset_code, warranty_expiry, (warranty_expiry - CURRENT_DATE) AS days_left FROM resources
       WHERE is_active AND warranty_expiry BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int ORDER BY warranty_expiry LIMIT 5`, [warrantyDays]),
    q(`SELECT * FROM (SELECT r.name, r.asset_code,
         (SELECT COUNT(*) FROM resource_assignments a WHERE a.resource_id = r.id)
       + (SELECT COUNT(*) FROM resource_bookings b WHERE b.resource_id = r.id AND b.status IN ('APPROVED','COMPLETED')) AS uses
       FROM resources r) x WHERE uses > 0 ORDER BY uses DESC LIMIT 5`),
    q(`SELECT r.name, r.asset_code, SUM(m.cost)::float AS total FROM resource_maintenance m JOIN resources r ON r.id = m.resource_id
       WHERE m.status = 'COMPLETED' GROUP BY r.id ORDER BY total DESC LIMIT 5`),
    q(`SELECT c.name, COUNT(r.id)::int AS n FROM resource_categories c JOIN resources r ON r.category_id = c.id AND r.is_active GROUP BY c.name ORDER BY n DESC`),
    q(`SELECT COUNT(*)::int AS n FROM resource_requests WHERE status = 'PENDING'`),
    q(`SELECT COUNT(*)::int AS n FROM resource_bookings WHERE status = 'PENDING'`),
    q(`SELECT COUNT(*)::int AS n FROM resource_issues WHERE status IN ('OPEN','UNDER_INSPECTION','IN_REPAIR')`)
  ]);
  const byStatus = Object.fromEntries(st.map((x) => [x.status, x.n]));
  return { byStatus, total: st.reduce((a, x) => a + x.n, 0), overdue: od[0].n, overdueList: odList, maintenanceCostMonth: cost[0].total,
           warranty, mostUsed: used, costliest: costly, byCategory: byCat, pendingRequests: pend[0].n, pendingBookings: pendB[0].n, openIssues: openI[0].n };
}

/* ═══════════════════════════ STUDENT-FACING ═══════════════════════════════
   These never select purchase_cost, purchase_date or created_by — students
   see operational info only (Rule: no sensitive internal data). */

/** Catalog browse. `quantity - units currently out` is computed once, in SQL,
 *  so it can never drift from resourceService's own unitsOut() logic. */
export async function browseResources(f) {
  const where = ['r.is_active', `r.status <> 'RETIRED'`], v = [];
  const add = (sql, val) => { v.push(val); where.push(sql.replace('?', `$${v.length}`)); };
  if (f.q) add(`(r.name ILIKE ? OR r.asset_code ILIKE ? OR r.brand ILIKE ?)`.replace(/\?/g, `$${v.length + 1}`), `%${f.q}%`);
  if (/^\d+$/.test(f.category || '')) add('r.category_id = ?', +f.category);
  if (['ISSUABLE', 'BOOKABLE'].includes(f.type)) add('r.resource_type = ?', f.type);
  const W = where.join(' AND ');
  const r = await db.query(
    `SELECT r.id, r.asset_code, r.name, r.resource_type, r.location, r.status, r.condition, r.quantity, r.unit, r.description,
            c.name AS category_name,
            GREATEST(0, r.quantity - COALESCE((SELECT SUM(a.quantity) FROM resource_assignments a
              WHERE a.resource_id = r.id AND a.status IN ('ACTIVE','RETURN_REQUESTED','OVERDUE')), 0))::int AS available_qty
     FROM resources r JOIN resource_categories c ON c.id = r.category_id
     WHERE ${W} ORDER BY r.resource_type, LOWER(r.name) LIMIT 60`, v);
  return r.rows;
}

export async function getResourceForStudent(id) {
  const r = await db.query(
    `SELECT r.id, r.asset_code, r.name, r.resource_type, r.description, r.brand, r.model, r.location, r.status, r.condition,
            r.quantity, r.unit, c.name AS category_name,
            GREATEST(0, r.quantity - COALESCE((SELECT SUM(a.quantity) FROM resource_assignments a
              WHERE a.resource_id = r.id AND a.status IN ('ACTIVE','RETURN_REQUESTED','OVERDUE')), 0))::int AS available_qty
     FROM resources r JOIN resource_categories c ON c.id = r.category_id WHERE r.id = $1 AND r.is_active`, [id]);
  return r.rows[0] || null;
}

export async function myStartups(userId) {
  const r = await db.query(`SELECT id, title FROM startups WHERE student_id = $1 AND is_deleted = false ORDER BY title`, [userId]);
  return r.rows;
}

export async function myRequests(userId) {
  const r = await db.query(
    `SELECT q.*, r.name AS resource_name, r.asset_code, s.title AS startup_title
     FROM resource_requests q JOIN resources r ON r.id = q.resource_id LEFT JOIN startups s ON s.id = q.startup_id
     WHERE q.user_id = $1 ORDER BY q.created_at DESC LIMIT 100`, [userId]);
  return r.rows;
}

export async function myAssignments(userId, view = 'current') {
  const cond = view === 'history' ? `a.status IN ('RETURNED','DAMAGED','LOST')` : `a.status IN ${OPEN}`;
  const r = await db.query(
    `SELECT a.*, r.name AS resource_name, r.asset_code, s.title AS startup_title,
            GREATEST(0, CURRENT_DATE - a.expected_return_at::date) AS days_overdue
     FROM resource_assignments a JOIN resources r ON r.id = a.resource_id LEFT JOIN startups s ON s.id = a.startup_id
     WHERE a.user_id = $1 AND ${cond} ORDER BY a.expected_return_at LIMIT 100`, [userId]);
  return r.rows;
}

export async function myBookings(userId, view = 'upcoming') {
  const cond = view === 'past' ? `(b.status IN ('COMPLETED','REJECTED','CANCELLED','NO_SHOW') OR b.ends_at < NOW())`
                                : `b.status IN ('PENDING','APPROVED') AND b.ends_at >= NOW()`;
  const r = await db.query(
    `SELECT b.*, r.name AS resource_name, r.asset_code FROM resource_bookings b JOIN resources r ON r.id = b.resource_id
     WHERE b.user_id = $1 AND ${cond} ORDER BY b.starts_at ${view === 'past' ? 'DESC' : 'ASC'} LIMIT 100`, [userId]);
  return r.rows;
}

/* ═══════════════════════════ ADMIN BOOKINGS ════════════════════════════════ */
export async function listBookings(status) {
  const ok = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED'].includes(status);
  const r = await db.query(
    `SELECT b.*, r.name AS resource_name, r.asset_code, u.name AS student_name, s.title AS startup_title
     FROM resource_bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id
     LEFT JOIN startups s ON s.id = b.startup_id ${ok ? 'WHERE b.status = $1' : ''}
     ORDER BY b.starts_at ${ok && status === 'PENDING' ? 'ASC' : 'DESC'} LIMIT 200`, ok ? [status] : []);
  const counts = await db.query(`SELECT status, COUNT(*)::int AS n FROM resource_bookings GROUP BY status`);
  return { rows: r.rows, counts: Object.fromEntries(counts.rows.map((x) => [x.status, x.n])) };
}

/* ═══════════════════════════ MENTOR (read-only, own startups only) ════════ */
export async function mentorResources(mentorId) {
  const [assignments, bookings] = await Promise.all([
    db.query(
      `SELECT a.*, r.name AS resource_name, r.asset_code, s.title AS startup_title, u.name AS student_name
       FROM resource_assignments a JOIN resources r ON r.id = a.resource_id JOIN startups s ON s.id = a.startup_id
       JOIN mentor_assignments ma ON ma.startup_id = s.id JOIN users u ON u.id = a.user_id
       WHERE ma.mentor_id = $1 AND a.status IN ${OPEN} ORDER BY a.expected_return_at`, [mentorId]),
    db.query(
      `SELECT b.*, r.name AS resource_name, r.asset_code, s.title AS startup_title, u.name AS student_name
       FROM resource_bookings b JOIN resources r ON r.id = b.resource_id JOIN startups s ON s.id = b.startup_id
       JOIN mentor_assignments ma ON ma.startup_id = s.id JOIN users u ON u.id = b.user_id
       WHERE ma.mentor_id = $1 AND b.status = 'APPROVED' AND b.ends_at >= NOW() ORDER BY b.starts_at`, [mentorId])
  ]);
  return { assignments: assignments.rows, bookings: bookings.rows };
}

/* ═══════════════════════════ ISSUES / MAINTENANCE (admin) ═════════════════ */
export async function listIssues(status) {
  const ok = ['OPEN', 'UNDER_INSPECTION', 'IN_REPAIR', 'RESOLVED', 'CLOSED'].includes(status);
  const r = await db.query(
    `SELECT i.*, r.name AS resource_name, r.asset_code, r.status AS resource_status, r.quantity,
            u.name AS reporter_name, au.name AS assigned_name
     FROM resource_issues i JOIN resources r ON r.id = i.resource_id LEFT JOIN users u ON u.id = i.reported_by
     LEFT JOIN users au ON au.id = i.assigned_to ${ok ? 'WHERE i.status = $1' : ''}
     ORDER BY i.created_at DESC LIMIT 200`, ok ? [status] : []);
  const counts = await db.query(`SELECT status, COUNT(*)::int AS n FROM resource_issues GROUP BY status`);
  return { rows: r.rows, counts: Object.fromEntries(counts.rows.map((x) => [x.status, x.n])) };
}

export async function listMaintenance(status) {
  const groups = { open: `m.status IN ('SCHEDULED','IN_PROGRESS')`, completed: `m.status = 'COMPLETED'`, cancelled: `m.status = 'CANCELLED'`, all: 'TRUE' };
  const where = groups[status] || groups.open;
  const r = await db.query(
    `SELECT m.*, r.name AS resource_name, r.asset_code, i.issue_type
     FROM resource_maintenance m JOIN resources r ON r.id = m.resource_id LEFT JOIN resource_issues i ON i.id = m.issue_id
     WHERE ${where} ORDER BY m.start_date DESC, m.id DESC LIMIT 200`);
  const counts = await db.query(`SELECT status, COUNT(*)::int AS n FROM resource_maintenance GROUP BY status`);
  return { rows: r.rows, counts: Object.fromEntries(counts.rows.map((x) => [x.status, x.n])) };
}

export async function getResourceBasic(id) {
  const r = await db.query(`SELECT id, name, asset_code, status, quantity, resource_type FROM resources WHERE id = $1 AND is_active`, [id]);
  return r.rows[0] || null;
}
