/**
 * resourceService: all resource business rules live here; routes stay thin.
 *
 * Every state change runs inside withTransaction() and locks the resource row
 * (SELECT ... FOR UPDATE) first, so two admins acting on the same asset are
 * serialised by PostgreSQL. Notifications are NOT sent from here: each function
 * returns the ids the route needs, and the route calls notificationService AFTER
 * commit, so a failed email can never undo a successful business action.
 */
import db, { withTransaction } from '../config/db.js';

export class ResourceError extends Error {
  constructor(message, code = 'INVALID') { super(message); this.code = code; }
}

const BLOCKED_STATUSES = ['RETIRED', 'MAINTENANCE', 'DAMAGED', 'UNAVAILABLE'];   // Rules 1–3

/* ── helpers ─────────────────────────────────────────────────────────────── */
async function lockResource(c, id) {
  const r = await c.query(`SELECT * FROM resources WHERE id = $1 AND is_active FOR UPDATE`, [id]);
  if (!r.rows[0]) throw new ResourceError('Resource not found.', 'NOT_FOUND');
  return r.rows[0];
}

async function history(c, resourceId, eventType, { from = null, to = null, actor = null, subjectUserId = null,
                        requestId = null, assignmentId = null, bookingId = null, issueId = null,
                        maintenanceId = null, note = null } = {}) {
  await c.query(
    `INSERT INTO resource_history (resource_id, event_type, from_status, to_status, actor_id, actor_name,
       subject_user_id, request_id, assignment_id, booking_id, issue_id, maintenance_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [resourceId, eventType, from, to, actor?.id ?? null, actor?.name ?? null, subjectUserId,
     requestId, assignmentId, bookingId, issueId, maintenanceId, note]);
}

async function setStatus(c, res, to, actor, eventType, extra = {}) {
  if (res.status === to) return;
  await c.query(`UPDATE resources SET status = $2 WHERE id = $1`, [res.id, to]);
  await history(c, res.id, eventType, { from: res.status, to, actor, ...extra });
}

/** Units currently out on loan (single source of truth for issuable availability). */
async function unitsOut(c, resourceId) {
  const r = await c.query(
    `SELECT COALESCE(SUM(quantity),0)::int AS n FROM resource_assignments
     WHERE resource_id = $1 AND status IN ('ACTIVE','RETURN_REQUESTED','OVERDUE')`, [resourceId]);
  return r.rows[0].n;
}

export async function availableQuantity(resourceId, client = db) {
  const r = await client.query(`SELECT quantity, status FROM resources WHERE id = $1 AND is_active`, [resourceId]);
  if (!r.rows[0] || BLOCKED_STATUSES.includes(r.rows[0].status)) return 0;
  return Math.max(0, r.rows[0].quantity - (await unitsOut(client, resourceId)));
}

const parseDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !isNaN(Date.parse(s)) ? s : null);
const todayISO = () => new Date().toISOString().slice(0, 10);
// pg returns DATE columns as local-midnight JS Dates; toISOString() would convert to UTC
// and roll the date back a day in any timezone ahead of UTC (IST included). Format from
// local getters instead — this is the same class of bug fixed earlier in form.ejs.
const toLocalISO = (d) => { const dt = new Date(d); const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`; };

/* ── resources ───────────────────────────────────────────────────────────── */
export async function createResource(actor, f) {
  const name = String(f.name || '').trim();
  if (!name) throw new ResourceError('Resource name is required.');
  if (!['ISSUABLE', 'BOOKABLE', 'CONSUMABLE', 'FACILITY'].includes(f.resource_type)) throw new ResourceError('Invalid resource type.');
  const qty = Number.isInteger(+f.quantity) && +f.quantity >= 0 ? +f.quantity : 1;
  const prefix = (String(f.code_prefix || name).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 3)).padEnd(3, 'X');

  try {
    return await withTransaction(async (c) => {
      const n = (await c.query(
        `INSERT INTO resource_code_counters (prefix, last_number) VALUES ($1, 1)
         ON CONFLICT (prefix) DO UPDATE SET last_number = resource_code_counters.last_number + 1
         RETURNING last_number`, [prefix])).rows[0].last_number;
      const code = `${prefix}-${String(n).padStart(3, '0')}`;
      const r = await c.query(
        `INSERT INTO resources (asset_code, name, category_id, resource_type, description, brand, model, serial_number,
           quantity, unit, purchase_date, purchase_cost, warranty_expiry, location, condition, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'unit'),$11,$12,$13,$14,COALESCE($15,'GOOD'),COALESCE($16,'AVAILABLE'),$17)
         RETURNING id, asset_code`,
        [code, name, f.category_id, f.resource_type, f.description || null, f.brand || null, f.model || null,
         f.serial_number || null, ['BOOKABLE', 'FACILITY'].includes(f.resource_type) ? 1 : qty, f.unit || null,
         f.purchase_date || null, f.purchase_cost || null, f.warranty_expiry || null, f.location || null,
         f.condition || null, f.status || null, actor.id]);
      await history(c, r.rows[0].id, 'ASSET_ADDED', { to: f.status || 'AVAILABLE', actor });
      return r.rows[0];
    });
  } catch (e) {
    if (e.code === '23505') throw new ResourceError('A resource with this serial number already exists.', 'DUPLICATE');
    if (e.code === '23503') throw new ResourceError('Selected category does not exist.');
    if (e.code === '23514') throw new ResourceError('Some values are invalid (check dates, cost and quantity).');
    throw e;
  }
}

/* ── requests (issuable) ─────────────────────────────────────────────────── */
export async function requestResource(user, resourceId, f) {
  const qty = +f.quantity || 1;
  const from = parseDate(f.requested_from), until = parseDate(f.requested_until);
  if (!Number.isInteger(qty) || qty < 1) throw new ResourceError('Quantity must be at least 1.');
  if (!from || !until) throw new ResourceError('Please provide valid dates.');
  if (from < todayISO()) throw new ResourceError('"Required from" cannot be in the past.');
  if (until < from) throw new ResourceError('Expected return cannot be before the start date.');
  if (!String(f.purpose || '').trim()) throw new ResourceError('Purpose is required.');

  return withTransaction(async (c) => {
    const res = await lockResource(c, resourceId);
    if (!['ISSUABLE', 'CONSUMABLE'].includes(res.resource_type)) throw new ResourceError('This resource is booked, not requested.');
    if (res.status === 'RETIRED') throw new ResourceError('This resource has been retired.');
    if (BLOCKED_STATUSES.includes(res.status)) throw new ResourceError(`This resource is ${res.status.toLowerCase()} and cannot be requested right now.`, 'UNAVAILABLE');
    if (qty > res.quantity) throw new ResourceError('Requested quantity exceeds what the centre holds.');
    if (f.startup_id) {                      // student may only attach their own startup
      const s = await c.query(`SELECT 1 FROM startups WHERE id=$1 AND student_id=$2 AND is_deleted=false`, [f.startup_id, user.id]);
      if (!s.rows[0]) throw new ResourceError('Selected startup was not found.');
    }
    try {
      const r = await c.query(
        `INSERT INTO resource_requests (resource_id, user_id, startup_id, quantity, purpose, requested_from, requested_until, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [resourceId, user.id, f.startup_id || null, qty, f.purpose.trim(), from, until, f.remarks || null]);
      await history(c, resourceId, 'REQUEST_SUBMITTED', { actor: user, subjectUserId: user.id, requestId: r.rows[0].id });
      return r.rows[0].id;
    } catch (e) {
      if (e.code === '23505') throw new ResourceError('You already have a pending request for this resource.', 'DUPLICATE');
      throw e;
    }
  });
}

export async function rejectRequest(admin, requestId, remarks) {
  if (!String(remarks || '').trim()) throw new ResourceError('A reason is required to reject a request.');
  return withTransaction(async (c) => {
    const r = await c.query(`SELECT * FROM resource_requests WHERE id=$1 FOR UPDATE`, [requestId]);
    const q = r.rows[0];
    if (!q) throw new ResourceError('Request not found.', 'NOT_FOUND');
    if (q.status !== 'PENDING') throw new ResourceError(`Request is already ${q.status.toLowerCase()}.`, 'STATE');
    await c.query(`UPDATE resource_requests SET status='REJECTED', reviewed_by=$2, reviewed_at=NOW(), admin_remarks=$3 WHERE id=$1`,
                  [requestId, admin.id, remarks.trim()]);
    await history(c, q.resource_id, 'REQUEST_REJECTED', { actor: admin, subjectUserId: q.user_id, requestId, note: remarks.trim() });
    return q.id;
  });
}

export async function approveRequest(admin, requestId, remarks = null) {
  return withTransaction(async (c) => {
    const q = (await c.query(`SELECT * FROM resource_requests WHERE id=$1 FOR UPDATE`, [requestId])).rows[0];
    if (!q) throw new ResourceError('Request not found.', 'NOT_FOUND');
    if (q.status !== 'PENDING') throw new ResourceError(`Request is already ${q.status.toLowerCase()}.`, 'STATE');
    const res = await lockResource(c, q.resource_id);
    if (BLOCKED_STATUSES.includes(res.status)) throw new ResourceError(`Resource is ${res.status.toLowerCase()} and cannot be approved.`, 'UNAVAILABLE');
    await c.query(`UPDATE resource_requests SET status='APPROVED', reviewed_by=$2, reviewed_at=NOW(), admin_remarks=$3 WHERE id=$1`,
                  [requestId, admin.id, remarks || null]);
    await history(c, res.id, 'REQUEST_APPROVED', { actor: admin, subjectUserId: q.user_id, requestId });
    return q.id;
  });
}

/* ── issue / return ──────────────────────────────────────────────────────── */
export async function issueResource(admin, requestId, { issue_condition, expected_return_at, remarks }) {
  if (!['NEW', 'GOOD', 'FAIR', 'MINOR_DAMAGE', 'MAJOR_DAMAGE'].includes(issue_condition)) throw new ResourceError('Select the condition at issue.');
  const due = new Date(expected_return_at);
  if (isNaN(due) || due <= new Date()) throw new ResourceError('Expected return must be a future date.');

  return withTransaction(async (c) => {
    // Lock order is always request -> resource, so concurrent issuers cannot deadlock.
    const q = (await c.query(`SELECT * FROM resource_requests WHERE id=$1 FOR UPDATE`, [requestId])).rows[0];
    if (!q) throw new ResourceError('Request not found.', 'NOT_FOUND');
    if (q.status !== 'APPROVED') throw new ResourceError('Only approved requests can be issued.', 'STATE');
    const res = await lockResource(c, q.resource_id);
    if (BLOCKED_STATUSES.includes(res.status)) throw new ResourceError(`Resource is ${res.status.toLowerCase()} and cannot be issued.`, 'UNAVAILABLE');
    const free = res.quantity - (await unitsOut(c, res.id));
    if (free < q.quantity) throw new ResourceError('Not enough units available: it was issued to someone else.', 'UNAVAILABLE');

    const a = (await c.query(
      `INSERT INTO resource_assignments (resource_id, request_id, user_id, startup_id, quantity, issued_by,
         expected_return_at, issue_condition, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [res.id, q.id, q.user_id, q.startup_id, q.quantity, admin.id, due, issue_condition, remarks || null])).rows[0];
    await c.query(`UPDATE resource_requests SET status='ISSUED' WHERE id=$1`, [q.id]);
    if (res.quantity === 1) await setStatus(c, res, 'ISSUED', admin, 'STATUS_CHANGED', { assignmentId: a.id });
    await history(c, res.id, 'ISSUED', { actor: admin, subjectUserId: q.user_id, requestId: q.id, assignmentId: a.id,
                                         note: `Condition at issue: ${issue_condition}` });
    return a.id;
  });
}

export async function requestReturn(user, assignmentId) {
  return withTransaction(async (c) => {
    const a = (await c.query(`SELECT * FROM resource_assignments WHERE id=$1 AND user_id=$2 FOR UPDATE`, [assignmentId, user.id])).rows[0];
    if (!a) throw new ResourceError('Assignment not found.', 'NOT_FOUND');      // also hides other students' rows (Rule 8)
    if (!['ACTIVE', 'OVERDUE'].includes(a.status)) throw new ResourceError('A return cannot be requested for this item.', 'STATE');
    await c.query(`UPDATE resource_assignments SET status='RETURN_REQUESTED', return_requested_at=NOW() WHERE id=$1`, [a.id]);
    await history(c, a.resource_id, 'RETURN_REQUESTED', { actor: user, subjectUserId: user.id, assignmentId: a.id });
    return a.id;
  });
}

export async function completeReturn(admin, assignmentId, { return_condition, inspection_notes }) {
  if (!['GOOD', 'FAIR', 'MINOR_DAMAGE', 'MAJOR_DAMAGE', 'LOST'].includes(return_condition)) throw new ResourceError('Select the current condition.');
  return withTransaction(async (c) => {
    const a = (await c.query(`SELECT * FROM resource_assignments WHERE id=$1 FOR UPDATE`, [assignmentId])).rows[0];
    if (!a) throw new ResourceError('Assignment not found.', 'NOT_FOUND');
    if (!['ACTIVE', 'RETURN_REQUESTED', 'OVERDUE'].includes(a.status)) throw new ResourceError('This item has already been returned.', 'STATE');
    const res = await lockResource(c, a.resource_id);

    const damaged = ['MINOR_DAMAGE', 'MAJOR_DAMAGE'].includes(return_condition);
    const lost = return_condition === 'LOST';
    const aStatus = lost ? 'LOST' : damaged ? 'DAMAGED' : 'RETURNED';
    await c.query(`UPDATE resource_assignments SET status=$2, returned_at=NOW(), received_by=$3, return_condition=$4, inspection_notes=$5 WHERE id=$1`,
                  [a.id, aStatus, admin.id, return_condition, inspection_notes || null]);
    await c.query(`UPDATE resource_requests SET status='COMPLETED' WHERE id=$1`, [a.request_id]);

    if (res.quantity === 1) {
      const next = lost ? 'UNAVAILABLE' : damaged ? 'DAMAGED' : 'AVAILABLE';
      if (damaged) await c.query(`UPDATE resources SET condition=$2 WHERE id=$1`, [res.id, return_condition]);
      await setStatus(c, res, next, admin, 'STATUS_CHANGED', { assignmentId: a.id });
    } else if (lost || damaged) {                       // stock item: take the affected units out of circulation
      await c.query(`UPDATE resources SET quantity = GREATEST(quantity - $2, 0) WHERE id=$1`, [res.id, a.quantity]);
    }
    await history(c, res.id, lost ? 'RETURNED_LOST' : 'RETURNED', { actor: admin, subjectUserId: a.user_id, assignmentId: a.id,
                                                                    note: `Condition: ${return_condition}. ${inspection_notes || ''}`.trim() });
    return { assignmentId: a.id, needsMaintenance: damaged };
  });
}

/** Flags overdue items; idempotent. Called by the scheduler and by admin dashboard loads. */
export async function markOverdue() {
  const r = await db.query(
    `UPDATE resource_assignments SET status='OVERDUE'
     WHERE status='ACTIVE' AND expected_return_at < NOW() RETURNING id, user_id, resource_id`);
  return r.rows;
}

/* ── bookings ────────────────────────────────────────────────────────────── */
export async function createBooking(user, resourceId, f) {
  const date = parseDate(f.booking_date);
  if (!date || date < todayISO()) throw new ResourceError('Choose a valid, non-past date.');
  if (!/^\d{2}:\d{2}$/.test(f.start_time || '') || !/^\d{2}:\d{2}$/.test(f.end_time || '')) throw new ResourceError('Choose valid start and end times.');
  if (f.end_time <= f.start_time) throw new ResourceError('End time must be after start time.');
  if (!String(f.purpose || '').trim()) throw new ResourceError('Purpose is required.');

  return withTransaction(async (c) => {
    const res = await lockResource(c, resourceId);
    if (!['BOOKABLE', 'FACILITY'].includes(res.resource_type)) throw new ResourceError('This resource is requested, not booked.');
    if (BLOCKED_STATUSES.includes(res.status)) throw new ResourceError(`This resource is ${res.status.toLowerCase()} and cannot be booked.`, 'UNAVAILABLE');
    const clash = await c.query(
      `SELECT 1 FROM resource_bookings WHERE resource_id=$1 AND status='APPROVED' AND booking_date=$2
         AND tsrange(starts_at, ends_at,'[)') && tsrange($2::date + $3::time, $2::date + $4::time,'[)')`,
      [resourceId, date, f.start_time, f.end_time]);
    if (clash.rows[0]) throw new ResourceError('That slot is already booked. Pick a different time.', 'CONFLICT');
    try {
      const r = await c.query(
        `INSERT INTO resource_bookings (resource_id,user_id,startup_id,booking_date,start_time,end_time,purpose,remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [resourceId, user.id, f.startup_id || null, date, f.start_time, f.end_time, f.purpose.trim(), f.remarks || null]);
      await history(c, resourceId, 'BOOKING_REQUESTED', { actor: user, subjectUserId: user.id, bookingId: r.rows[0].id });
      return r.rows[0].id;
    } catch (e) {
      if (e.code === '23P01') throw new ResourceError('You already have a booking overlapping this time.', 'CONFLICT');
      throw e;
    }
  });
}

export async function approveBooking(admin, bookingId) {
  try {
    return await withTransaction(async (c) => {
      const b = (await c.query(`SELECT * FROM resource_bookings WHERE id=$1 FOR UPDATE`, [bookingId])).rows[0];
      if (!b) throw new ResourceError('Booking not found.', 'NOT_FOUND');
      if (b.status !== 'PENDING') throw new ResourceError(`Booking is already ${b.status.toLowerCase()}.`, 'STATE');
      const res = await lockResource(c, b.resource_id);
      if (BLOCKED_STATUSES.includes(res.status)) throw new ResourceError(`Resource is ${res.status.toLowerCase()}.`, 'UNAVAILABLE');
      await c.query(`UPDATE resource_bookings SET status='APPROVED', approved_by=$2, approved_at=NOW() WHERE id=$1`, [b.id, admin.id]);
      await history(c, res.id, 'BOOKING_APPROVED', { actor: admin, subjectUserId: b.user_id, bookingId: b.id });
      return b.id;
    });
  } catch (e) {
    if (e.code === '23P01') throw new ResourceError('Cannot approve: it overlaps an already approved booking.', 'CONFLICT');
    throw e;
  }
}

export async function rejectBooking(admin, bookingId, remarks) {
  if (!String(remarks || '').trim()) throw new ResourceError('A reason is required to reject a booking.');
  return withTransaction(async (c) => {
    const b = (await c.query(`SELECT * FROM resource_bookings WHERE id=$1 FOR UPDATE`, [bookingId])).rows[0];
    if (!b) throw new ResourceError('Booking not found.', 'NOT_FOUND');
    if (b.status !== 'PENDING') throw new ResourceError(`Booking is already ${b.status.toLowerCase()}.`, 'STATE');
    await c.query(`UPDATE resource_bookings SET status='REJECTED', admin_remarks=$2 WHERE id=$1`, [b.id, remarks.trim()]);
    await history(c, b.resource_id, 'BOOKING_REJECTED', { actor: admin, subjectUserId: b.user_id, bookingId: b.id, note: remarks.trim() });
    return b.id;
  });
}

export async function cancelBooking(user, bookingId) {
  return withTransaction(async (c) => {
    const b = (await c.query(`SELECT * FROM resource_bookings WHERE id=$1 AND user_id=$2 FOR UPDATE`, [bookingId, user.id])).rows[0];
    if (!b) throw new ResourceError('Booking not found.', 'NOT_FOUND');
    if (!['PENDING', 'APPROVED'].includes(b.status)) throw new ResourceError('This booking can no longer be cancelled.', 'STATE');
    await c.query(`UPDATE resource_bookings SET status='CANCELLED' WHERE id=$1`, [b.id]);
    await history(c, b.resource_id, 'BOOKING_CANCELLED', { actor: user, subjectUserId: user.id, bookingId: b.id });
    return b.id;
  });
}

/** Approved bookings for one resource on one day, for the availability view. */
export async function dayAvailability(resourceId, date) {
  const d = parseDate(date) || todayISO();
  const r = await db.query(
    `SELECT b.start_time, b.end_time, COALESCE(s.title, u.name) AS booked_by
     FROM resource_bookings b JOIN users u ON u.id=b.user_id LEFT JOIN startups s ON s.id=b.startup_id
     WHERE b.resource_id=$1 AND b.booking_date=$2 AND b.status='APPROVED' ORDER BY b.start_time`, [resourceId, d]);
  return { date: d, slots: r.rows };
}

/* ── edit / deactivate / cancel / history ────────────────────────────────── */
const MANUAL_STATUSES = ['AVAILABLE', 'MAINTENANCE', 'DAMAGED', 'RETIRED', 'UNAVAILABLE'];   // ISSUED/IN_USE/RESERVED are set only by workflows

export async function updateResource(actor, id, f) {
  const name = String(f.name || '').trim();
  if (!name) throw new ResourceError('Resource name is required.');
  try {
    return await withTransaction(async (c) => {
      const res = await lockResource(c, id);
      const out = await unitsOut(c, id);
      const status = f.status || res.status;
      const changed = status !== res.status;
      if (changed && !MANUAL_STATUSES.includes(status)) throw new ResourceError('That status is set automatically by issuing or booking.');
      if (changed && out > 0 && res.quantity === 1) throw new ResourceError('This item is currently issued. Complete its return first.', 'STATE');
      const qty = ['BOOKABLE', 'FACILITY'].includes(res.resource_type) ? 1 : (Number.isInteger(+f.quantity) ? +f.quantity : res.quantity);
      if (qty < out) throw new ResourceError(`Quantity cannot be below the ${out} unit(s) currently issued.`);
      await c.query(
        `UPDATE resources SET name=$2, category_id=$3, description=$4, brand=$5, model=$6, serial_number=$7, quantity=$8,
           unit=COALESCE($9,unit), purchase_date=$10, purchase_cost=$11, warranty_expiry=$12, location=$13,
           condition=COALESCE($14,condition), status=$15 WHERE id=$1`,
        [id, name, f.category_id, f.description || null, f.brand || null, f.model || null, f.serial_number || null, qty,
         f.unit || null, f.purchase_date || null, f.purchase_cost || null, f.warranty_expiry || null, f.location || null,
         f.condition || null, status]);
      await history(c, id, changed ? 'STATUS_CHANGED' : 'ASSET_EDITED', { from: res.status, to: status, actor, note: changed ? (f.note || null) : null });
      return res.asset_code;
    });
  } catch (e) {
    if (e.code === '23505') throw new ResourceError('Another resource already uses this serial number.', 'DUPLICATE');
    if (e.code === '23503') throw new ResourceError('Selected category does not exist.');
    if (e.code === '23514') throw new ResourceError('Some values are invalid (check dates, cost and quantity).');
    throw e;
  }
}

export async function deactivateResource(actor, id) {
  return withTransaction(async (c) => {
    const res = await lockResource(c, id);
    if ((await unitsOut(c, id)) > 0) throw new ResourceError('Cannot deactivate: it is currently issued.', 'STATE');
    const b = await c.query(`SELECT 1 FROM resource_bookings WHERE resource_id=$1 AND status IN ('PENDING','APPROVED') AND ends_at > NOW() LIMIT 1`, [id]);
    if (b.rows[0]) throw new ResourceError('Cannot deactivate: it has upcoming bookings.', 'STATE');
    await c.query(`UPDATE resources SET is_active=false WHERE id=$1`, [id]);   // soft delete; all history stays
    await history(c, id, 'DEACTIVATED', { from: res.status, actor });
    return res.asset_code;
  });
}

export async function cancelRequest(admin, requestId, remarks) {
  return withTransaction(async (c) => {
    const q = (await c.query(`SELECT * FROM resource_requests WHERE id=$1 FOR UPDATE`, [requestId])).rows[0];
    if (!q) throw new ResourceError('Request not found.', 'NOT_FOUND');
    if (!['PENDING', 'APPROVED'].includes(q.status)) throw new ResourceError('Only pending or approved requests can be cancelled.', 'STATE');
    await c.query(`UPDATE resource_requests SET status='CANCELLED', reviewed_by=$2, reviewed_at=NOW(), admin_remarks=$3 WHERE id=$1`,
                  [requestId, admin.id, remarks || null]);
    await history(c, q.resource_id, 'REQUEST_CANCELLED', { actor: admin, subjectUserId: q.user_id, requestId, note: remarks || null });
    return q.id;
  });
}

export async function getHistory(resourceId) {
  const r = await db.query(
    `SELECT h.*, u.name AS subject_name FROM resource_history h LEFT JOIN users u ON u.id = h.subject_user_id
     WHERE h.resource_id = $1 ORDER BY h.created_at DESC, h.id DESC`, [resourceId]);
  return r.rows;
}

/* ── student-owned cancellation (separate from admin cancelRequest above) ─── */
export async function cancelOwnRequest(user, requestId) {
  return withTransaction(async (c) => {
    const q = (await c.query(`SELECT * FROM resource_requests WHERE id=$1 AND user_id=$2 FOR UPDATE`, [requestId, user.id])).rows[0];
    if (!q) throw new ResourceError('Request not found.', 'NOT_FOUND');
    if (q.status !== 'PENDING') throw new ResourceError('Only a pending request can be withdrawn. Ask an admin to cancel an approved one.', 'STATE');
    await c.query(`UPDATE resource_requests SET status='CANCELLED' WHERE id=$1`, [requestId]);
    await history(c, q.resource_id, 'REQUEST_CANCELLED', { actor: user, subjectUserId: user.id, requestId, note: 'Withdrawn by student' });
    return q.id;
  });
}

/** Report a problem on a resource the student currently holds (or any resource, unassigned issue). Full triage lands in step 3. */
export async function reportIssue(user, resourceId, f) {
  if (!['DAMAGED', 'MALFUNCTION', 'MISSING_PART', 'LOST', 'OTHER'].includes(f.issue_type)) throw new ResourceError('Select an issue type.');
  if (!String(f.description || '').trim()) throw new ResourceError('Please describe the problem.');
  return withTransaction(async (c) => {
    const res = await lockResource(c, resourceId);
    let assignmentId = null;
    if (f.assignment_id) {
      const a = await c.query(`SELECT id FROM resource_assignments WHERE id=$1 AND user_id=$2 AND resource_id=$3`, [f.assignment_id, user.id, resourceId]);
      assignmentId = a.rows[0]?.id ?? null;
    } else {
      // No assignment_id supplied (the common case — the form doesn't ask for one):
      // auto-link the student's own active loan of this resource, if any.
      const a = await c.query(
        `SELECT id FROM resource_assignments WHERE user_id=$1 AND resource_id=$2 AND status IN ('ACTIVE','RETURN_REQUESTED','OVERDUE')
         ORDER BY issued_at DESC LIMIT 1`, [user.id, resourceId]);
      assignmentId = a.rows[0]?.id ?? null;
    }
    const r = await c.query(
      `INSERT INTO resource_issues (resource_id, reported_by, assignment_id, issue_type, description, attachment, priority)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'MEDIUM')) RETURNING id`,
      [resourceId, user.id, assignmentId, f.issue_type, f.description.trim(), f.attachment || null, f.priority || null]);
    await history(c, res.id, 'ISSUE_REPORTED', { actor: user, subjectUserId: user.id, issueId: r.rows[0].id, note: `${f.issue_type}: ${f.description.trim().slice(0, 120)}` });
    return r.rows[0].id;
  });
}

/* ── issues: triage (no resource state change) ──────────────────────────── */
export async function setIssueUnderInspection(admin, issueId, assignedTo = null) {
  return withTransaction(async (c) => {
    const i = (await c.query(`SELECT * FROM resource_issues WHERE id=$1 FOR UPDATE`, [issueId])).rows[0];
    if (!i) throw new ResourceError('Issue not found.', 'NOT_FOUND');
    if (i.status !== 'OPEN') throw new ResourceError(`Issue is already ${i.status.toLowerCase().replace(/_/g, ' ')}.`, 'STATE');
    await c.query(`UPDATE resource_issues SET status='UNDER_INSPECTION', assigned_to=$2 WHERE id=$1`, [issueId, assignedTo || admin.id]);
    await history(c, i.resource_id, 'ISSUE_UNDER_INSPECTION', { actor: admin, issueId });
    return i.id;
  });
}

export async function resolveIssue(admin, issueId, { resolution, status = 'RESOLVED' }) {
  if (!['RESOLVED', 'CLOSED'].includes(status)) throw new ResourceError('Invalid resolution status.');
  if (!String(resolution || '').trim()) throw new ResourceError('Please describe how this was resolved.');
  return withTransaction(async (c) => {
    const i = (await c.query(`SELECT * FROM resource_issues WHERE id=$1 FOR UPDATE`, [issueId])).rows[0];
    if (!i) throw new ResourceError('Issue not found.', 'NOT_FOUND');
    if (['RESOLVED', 'CLOSED'].includes(i.status)) throw new ResourceError('This issue is already closed.', 'STATE');
    await c.query(`UPDATE resource_issues SET status=$2, resolution=$3, resolved_at=NOW() WHERE id=$1`, [issueId, status, resolution.trim()]);
    await history(c, i.resource_id, 'ISSUE_RESOLVED', { actor: admin, issueId, note: resolution.trim().slice(0, 160) });
    return i.id;
  });
}

/* ── maintenance ──────────────────────────────────────────────────────────
 * Rule 2/3: a resource under maintenance or damaged cannot be issued/booked —
 * already enforced by BLOCKED_STATUSES throughout this file. Starting or
 * completing maintenance is the only place that status is set or cleared. */
const MAINT_START_FROM = ['AVAILABLE', 'DAMAGED'];   // can't start on something out on loan or booked

export async function startMaintenance(admin, resourceId, f) {
  if (!String(f.description || '').trim() && !f.issue_id) throw new ResourceError('Please describe the work needed.');
  const start = parseDate(f.start_date) || todayISO();
  const expected = f.expected_completion ? parseDate(f.expected_completion) : null;
  if (f.expected_completion && !expected) throw new ResourceError('Expected completion date is invalid.');

  return withTransaction(async (c) => {
    const res = await lockResource(c, resourceId);
    if (!MAINT_START_FROM.includes(res.status)) throw new ResourceError(`Cannot start maintenance while the resource is ${res.status.toLowerCase()}.`, 'STATE');
    let issue = null;
    if (f.issue_id) {
      issue = (await c.query(`SELECT * FROM resource_issues WHERE id=$1 AND resource_id=$2 FOR UPDATE`, [f.issue_id, resourceId])).rows[0];
      if (!issue) throw new ResourceError('Linked issue not found for this resource.', 'NOT_FOUND');
      if (['RESOLVED', 'CLOSED'].includes(issue.status)) throw new ResourceError('That issue is already closed.', 'STATE');
    }
    const m = (await c.query(
      `INSERT INTO resource_maintenance (resource_id, issue_id, maintenance_type, description, vendor, technician,
         start_date, expected_completion, status, created_by)
       VALUES ($1,$2,COALESCE($3,'REPAIR'),$4,$5,$6,$7,$8, CASE WHEN $7::date <= CURRENT_DATE THEN 'IN_PROGRESS' ELSE 'SCHEDULED' END, $9)
       RETURNING id, status`,
      [resourceId, f.issue_id || null, f.maintenance_type || null, f.description || null, f.vendor || null,
       f.technician || null, start, expected, admin.id])).rows[0];

    if (res.quantity === 1) await setStatus(c, res, 'MAINTENANCE', admin, 'STATUS_CHANGED', { maintenanceId: m.id });
    if (issue) await c.query(`UPDATE resource_issues SET status='IN_REPAIR' WHERE id=$1`, [issue.id]);
    await history(c, resourceId, 'MAINTENANCE_STARTED', { actor: admin, maintenanceId: m.id, issueId: f.issue_id || null,
      note: f.description || (issue ? `From issue: ${issue.issue_type}` : null) });
    return m.id;
  });
}

export async function completeMaintenance(admin, maintenanceId, f) {
  const cost = f.cost === '' || f.cost == null ? 0 : Number(f.cost);
  if (!Number.isFinite(cost) || cost < 0) throw new ResourceError('Cost must be a valid non-negative number.');
  const completion = parseDate(f.completion_date) || todayISO();
  const conditionAfter = f.condition_after || 'GOOD';
  if (!['NEW', 'GOOD', 'FAIR'].includes(conditionAfter)) throw new ResourceError('Select a valid post-repair condition.');

  return withTransaction(async (c) => {
    const m = (await c.query(`SELECT * FROM resource_maintenance WHERE id=$1 FOR UPDATE`, [maintenanceId])).rows[0];
    if (!m) throw new ResourceError('Maintenance record not found.', 'NOT_FOUND');
    if (!['SCHEDULED', 'IN_PROGRESS'].includes(m.status)) throw new ResourceError(`This maintenance is already ${m.status.toLowerCase()}.`, 'STATE');
    if (completion < toLocalISO(m.start_date)) throw new ResourceError('Completion date cannot be before the start date.');
    const res = await lockResource(c, m.resource_id);

    await c.query(`UPDATE resource_maintenance SET status='COMPLETED', completion_date=$2, cost=$3, notes=$4 WHERE id=$1`,
                  [maintenanceId, completion, cost, f.notes || null]);
    if (res.quantity === 1) {
      await c.query(`UPDATE resources SET condition=$2 WHERE id=$1`, [res.id, conditionAfter]);
      await setStatus(c, res, 'AVAILABLE', admin, 'STATUS_CHANGED', { maintenanceId });
    }
    if (m.issue_id) {
      await c.query(`UPDATE resource_issues SET status='RESOLVED', resolution=COALESCE($2, resolution, 'Repaired.'), resolved_at=NOW() WHERE id=$1 AND status <> 'CLOSED'`,
                    [m.issue_id, f.notes || null]);
    }
    await history(c, res.id, 'MAINTENANCE_COMPLETED', { actor: admin, maintenanceId, note: `Cost: ₹${cost}. ${f.notes || ''}`.trim() });
    return { resourceId: res.id };
  });
}

export async function cancelMaintenance(admin, maintenanceId, reason) {
  return withTransaction(async (c) => {
    const m = (await c.query(`SELECT * FROM resource_maintenance WHERE id=$1 FOR UPDATE`, [maintenanceId])).rows[0];
    if (!m) throw new ResourceError('Maintenance record not found.', 'NOT_FOUND');
    if (!['SCHEDULED', 'IN_PROGRESS'].includes(m.status)) throw new ResourceError(`This maintenance is already ${m.status.toLowerCase()}.`, 'STATE');
    const res = await lockResource(c, m.resource_id);
    await c.query(`UPDATE resource_maintenance SET status='CANCELLED', notes=COALESCE($2, notes) WHERE id=$1`, [maintenanceId, reason || null]);
    if (res.quantity === 1 && res.status === 'MAINTENANCE') await setStatus(c, res, 'AVAILABLE', admin, 'STATUS_CHANGED', { maintenanceId });
    await history(c, res.id, 'MAINTENANCE_CANCELLED', { actor: admin, maintenanceId, note: reason || null });
    return m.id;
  });
}
