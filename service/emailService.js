/**
 * emailService: the ONLY module that talks to Nodemailer.
 *
 * Responsibilities: render a template, write an email_logs row, send, record
 * the outcome. It NEVER throws: callers get { status: 'sent' | 'failed' | 'duplicate' }.
 *
 * Config: SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / EMAIL_FROM / EMAIL_FROM_NAME.
 * The legacy names (EMAIL_HOST / EMAIL_PORT / EMAIL_USER / EMAIL_PASSWORD) still
 * work, so existing .env files keep functioning.
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';
import db from '../config/db.js';
import { renderEmail } from './emailTemplates.js';

const env = () => process.env;

function config() {
  const e = env();
  return {
    host:     e.SMTP_HOST || e.EMAIL_HOST,
    port:     Number(e.SMTP_PORT || e.EMAIL_PORT || 587),
    user:     e.SMTP_USER || e.EMAIL_USER,
    pass:     e.SMTP_PASS || e.EMAIL_PASSWORD,
    from:     e.EMAIL_FROM || e.SMTP_USER || e.EMAIL_USER,
    fromName: e.EMAIL_FROM_NAME || 'IncuPortal',
  };
}

let transporter = null;
let warned = false;

/** Tests (or a future SES/SendGrid adapter) can inject any object with sendMail(). */
export function setTransporter(t) { transporter = t; }

function getTransporter() {
  if (transporter) return transporter;
  const c = config();
  if (!c.host) {
    if (!warned) { console.warn('[email] SMTP is not configured (set SMTP_HOST etc.). Emails will be logged as failed.'); warned = true; }
    return null;
  }
  transporter = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.port === 465,                    // 465 = implicit TLS, others use STARTTLS
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
  });
  return transporter;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (s, n) => String(s ?? '').slice(0, n);

/** Returns the new log id, or null if the (recipient, dedupe_key) pair already exists. */
async function insertLog(f) {
  const r = await db.query(
    `INSERT INTO email_logs
       (recipient, subject, template, category, status, error_message,
        related_user_id, related_entity_type, related_entity_id, dedupe_key, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [f.to, clip(f.subject, 255), f.template, f.category, f.status, f.error ? clip(f.error, 500) : null,
     f.userId ?? null, f.entityType ?? null, f.entityId ?? null, f.dedupeKey ?? null,
     f.status === 'sent' ? new Date() : null]
  );
  return r.rows[0]?.id ?? null;
}

/**
 * @param {object} job
 * @param {string} job.to          recipient address (taken from the DB by callers, never from a request body)
 * @param {string} job.template    key from emailTemplates.js. INTERNAL only, never client-selectable
 * @param {object} job.data        template data (may contain reset links; it is NOT persisted anywhere)
 * @param {number} [job.userId] [job.entityType] [job.entityId] [job.dedupeKey]
 */
export async function sendTemplatedEmail(job) {
  const meta = { template: job.template, userId: job.userId, entityType: job.entityType,
                 entityId: job.entityId, dedupeKey: job.dedupeKey, to: job.to };
  try {
    let rendered;
    try {
      rendered = await renderEmail(job.template, job.data);
    } catch (err) {
      await insertLog({ ...meta, subject: `[render error] ${job.template}`, category: 'unknown', status: 'failed', error: err.message });
      return { status: 'failed', error: err.message };
    }

    const base = { ...meta, subject: rendered.subject, category: rendered.category };

    if (!EMAIL_RE.test(job.to || '')) {
      await insertLog({ ...base, status: 'failed', error: 'Invalid recipient address' });
      return { status: 'failed', error: 'Invalid recipient address' };
    }

    const logId = await insertLog({ ...base, status: 'queued' });
    if (!logId) return { status: 'duplicate' };

    const t = getTransporter();
    if (!t) {
      await db.query(`UPDATE email_logs SET status='failed', error_message=$2 WHERE id=$1`, [logId, 'SMTP is not configured']);
      return { status: 'failed', error: 'SMTP is not configured' };
    }

    const c = config();
    try {
      const info = await t.sendMail({
        from: `"${c.fromName}" <${c.from}>`,
        to: job.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      await db.query(`UPDATE email_logs SET status='sent', sent_at=NOW(), message_id=$2 WHERE id=$1`,
                     [logId, clip(info?.messageId, 255)]);
      return { status: 'sent', logId };
    } catch (err) {
      await db.query(`UPDATE email_logs SET status='failed', error_message=$2 WHERE id=$1`, [logId, clip(err.message, 500)]);
      console.error(`[email] send failed (${job.template} → log #${logId}):`, err.message);
      return { status: 'failed', error: err.message, logId };
    }
  } catch (err) {
    // Even the logging failed (e.g. DB down). Business flow must still continue.
    console.error('[email] unexpected error:', err.message);
    return { status: 'failed', error: err.message };
  }
}
