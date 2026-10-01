/**
 * emailTemplates: registry + renderer.
 *
 * Each template = one EJS "prose" file in templates/emails/ + an entry below that
 * defines subject, preference category, the key/value detail rows, status badge
 * and call-to-action. The shared shell (header, card, button, footer) lives in
 * templates/emails/_layout.ejs, so visual changes happen in exactly one place.
 *
 * Template keys are internal constants. They are never read from request input.
 * EJS <%= %> auto-escapes every value, so user-supplied text (startup names,
 * feedback...) cannot inject HTML into an email.
 */
import path from 'path';
import ejs from 'ejs';
import { fileURLToPath } from 'url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'emails');

/** Preference categories. `mandatory` ones can never be switched off. */
export const CATEGORIES = {
  startup_updates:  { label: 'Startup updates',          description: 'Submission, review decisions and mentor assignments', mandatory: false },
  funding_updates:  { label: 'Funding updates',          description: 'Funding requests and decisions',                     mandatory: false },
  mentor_feedback:  { label: 'Mentor feedback',          description: 'New feedback from your mentor',                      mandatory: false },
  progress_updates: { label: 'Progress updates',         description: 'Progress posted by teams you mentor',                mandatory: false },
  resource_updates: { label: 'Resource updates',         description: 'Requests, bookings, issued equipment and maintenance', mandatory: false },
  system:           { label: 'System & security',        description: 'Account, password and role notifications',           mandatory: true  },
};

const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
const stage = (s) => (String(s).toLowerCase() === 'mvp' ? 'MVP' : cap(s));
const row = (label, value) => (value ? [label, String(value)] : null);
const rows = (...r) => r.filter(Boolean);
const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

const TEMPLATES = {
  'welcome': {
    category: 'system',
    subject: (d) => d.role === 'mentor'
      ? 'Welcome to IncuPortal — Mentor Account Activated'
      : 'Welcome to IncuPortal — Your Startup Journey Begins 🚀',
    details: (d) => rows(row('Name', d.name), row('Role', cap(d.role))),
    cta: () => 'Open my dashboard',
  },
  'startup-submitted': {
    category: 'startup_updates',
    subject: (d) => `Startup Submitted Successfully — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Pending review', tone: 'pending' }),
    details: (d) => rows(row('Startup', d.startupTitle), row('Domain', d.domain), row('Stage', stage(d.stage)),
                         row('Submitted', d.submittedAt), row('Status', 'Pending review')),
    cta: () => 'View my startup',
  },
  'startup-submitted-admin': {
    category: 'startup_updates',
    subject: (d) => `New Startup Submission Requires Review — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Needs review', tone: 'pending' }),
    details: (d) => rows(row('Student', d.studentName), row('Student email', d.studentEmail), row('Startup', d.startupTitle),
                         row('Domain', d.domain), row('Stage', stage(d.stage)), row('Submitted', d.submittedAt)),
    cta: () => 'Review submission',
  },
  'startup-approved': {
    category: 'startup_updates',
    subject: (d) => `🎉 Your Startup Has Been Approved — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Approved', tone: 'approved' }),
    details: (d) => rows(row('Startup', d.startupTitle), row('Domain', d.domain), row('Stage', stage(d.stage)), row('Status', 'Approved')),
    cta: () => 'View startup dashboard',
  },
  'startup-rejected': {
    category: 'startup_updates',
    subject: (d) => `Update on Your Startup Submission — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Rejected', tone: 'rejected' }),
    details: (d) => rows(row('Startup', d.startupTitle), row('Domain', d.domain), row('Stage', stage(d.stage)), row('Status', 'Rejected')),
    cta: () => 'View feedback on dashboard',
  },
  'mentor-assigned-student': {
    category: 'startup_updates',
    subject: (d) => `Mentor Assigned to Your Startup — ${oneLine(d.startupTitle)}`,
    details: (d) => rows(row('Mentor', d.mentorName), row('Mentor email', d.mentorEmail), row('Startup', d.startupTitle), row('Domain', d.domain)),
    cta: () => 'View startup dashboard',
  },
  'mentor-assigned-mentor': {
    category: 'startup_updates',
    subject: (d) => `New Startup Assigned for Mentorship — ${oneLine(d.startupTitle)}`,
    details: (d) => rows(row('Startup', d.startupTitle), row('Domain', d.domain), row('Student', d.studentName), row('Student email', d.studentEmail)),
    cta: () => 'Open mentor dashboard',
  },
  'funding-submitted': {
    category: 'funding_updates',
    subject: (d) => `Funding Request Submitted — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Pending review', tone: 'pending' }),
    details: (d) => rows(row('Startup', d.startupTitle), row('Amount requested', d.amount), row('Purpose', d.purpose),
                         row('Proposal', d.proposal), row('Submitted', d.submittedAt)),
    cta: () => 'Track my request',
  },
  'funding-submitted-admin': {
    category: 'funding_updates',
    subject: (d) => `New Funding Request Requires Review — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Needs review', tone: 'pending' }),
    details: (d) => rows(row('Startup', d.startupTitle), row('Student', d.studentName), row('Student email', d.studentEmail),
                         row('Amount requested', d.amount), row('Purpose', d.purpose), row('Proposal', d.proposal), row('Submitted', d.submittedAt)),
    cta: () => 'Review funding requests',
  },
  'funding-approved': {
    category: 'funding_updates',
    subject: (d) => `Funding Request Approved — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Approved', tone: 'approved' }),
    details: (d) => rows(row('Startup', d.startupTitle), row('Amount approved', d.amount), row('Purpose', d.purpose), row('Status', 'Approved')),
    cta: () => 'View startup dashboard',
  },
  'funding-rejected': {
    category: 'funding_updates',
    subject: (d) => `Funding Request Update — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Rejected', tone: 'rejected' }),
    details: (d) => rows(row('Startup', d.startupTitle), row('Amount requested', d.amount), row('Purpose', d.purpose), row('Status', 'Rejected')),
    cta: () => 'View startup dashboard',
  },
  'mentor-feedback': {
    category: 'mentor_feedback',
    subject: (d) => `New Mentor Feedback Available — ${oneLine(d.startupTitle)}`,
    details: (d) => rows(row('Mentor', d.mentorName), row('Startup', d.startupTitle), row('Date', d.date)),
    cta: () => 'Read full feedback',
  },
  'progress-update': {
    category: 'progress_updates',
    subject: (d) => `New Progress Update — ${oneLine(d.startupTitle)}`,
    details: (d) => rows(row('Startup', d.startupTitle), row('Posted by', d.studentName), row('Date', d.date)),
    cta: () => 'Review the update',
  },
  'password-reset': {
    category: 'system',
    subject: () => 'Reset Your IncuPortal Password',
    details: () => [],
    cta: () => 'Reset my password',
  },
  'password-changed': {
    category: 'system',
    subject: () => 'Your IncuPortal Password Was Changed',
    details: (d) => rows(row('Changed', d.changedAt)),
    cta: () => 'Sign in',
  },
  'role-changed': {
    category: 'system',
    subject: () => 'Your IncuPortal Role Was Updated',
    details: (d) => rows(row('Previous role', cap(d.oldRole)), row('New role', cap(d.newRole))),
    cta: () => 'Open my dashboard',
  },

  /* ── Startup review meetings ──────────────────────────────────────────── */
  'meeting-scheduled': {
    category: 'startup_updates',
    subject: (d) => `Review Meeting Scheduled — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Meeting scheduled', tone: 'pending' }),
    details: (d) => rows(row('Startup', d.startupTitle), row('When', `${d.dateLabel}, ${d.timeLabel} (IST)`),
                         row('Type', cap(String(d.meetingType).toLowerCase().replace('_', ' '))),
                         row('Location', d.location), row('Meeting link', d.meetingLink)),
    cta: () => 'View meeting details',
  },
  'meeting-rescheduled': {
    category: 'startup_updates',
    subject: (d) => `Review Meeting Rescheduled — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'New time', tone: 'pending' }),
    details: (d) => rows(row('Startup', d.startupTitle), row('New date/time', `${d.dateLabel}, ${d.timeLabel} (IST)`),
                         row('Location', d.location), row('Meeting link', d.meetingLink)),
    cta: () => 'View meeting details',
  },
  'meeting-cancelled': {
    category: 'startup_updates',
    subject: (d) => `Review Meeting Cancelled — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Cancelled', tone: 'rejected' }),
    details: (d) => rows(row('Startup', d.startupTitle), row('Was scheduled for', `${d.dateLabel}, ${d.timeLabel}`)),
    cta: () => 'View startup',
  },
  'meeting-reminder': {
    category: 'startup_updates',
    subject: (d) => `Reminder: Review Meeting Tomorrow — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Tomorrow', tone: 'pending' }),
    details: (d) => rows(row('Startup', d.startupTitle), row('When', `${d.dateLabel}, ${d.timeLabel} (IST)`), row('Location', d.location)),
    cta: () => 'View meeting details',
  },
  'meeting-completed': {
    category: 'startup_updates',
    subject: (d) => `Review Meeting Completed — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Completed', tone: 'approved' }),
    details: (d) => rows(row('Startup', d.startupTitle)),
    cta: () => 'View startup',
  },
  'changes-requested': {
    category: 'startup_updates',
    subject: (d) => `Action Needed on Your Startup — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Changes requested', tone: 'pending' }),
    details: (d) => rows(row('Startup', d.startupTitle)),
    cta: () => 'Update my submission',
  },
  'reschedule-requested-admin': {
    category: 'startup_updates',
    subject: (d) => `Reschedule Requested — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Needs a decision', tone: 'pending' }),
    details: (d) => rows(row('Startup', d.startupTitle), row('Student', d.studentName),
                         row('Current time', `${d.dateLabel}, ${d.timeLabel}`)),
    cta: () => 'Review the request',
  },
  'reschedule-rejected': {
    category: 'startup_updates',
    subject: (d) => `Reschedule Request Update — ${oneLine(d.startupTitle)}`,
    badge: () => ({ text: 'Not approved', tone: 'rejected' }),
    details: (d) => rows(row('Startup', d.startupTitle), row('Meeting stays at', `${d.dateLabel}, ${d.timeLabel}`)),
    cta: () => 'View meeting details',
  },

  /* ── Resource management ──────────────────────────────────────────────── */
  'resource-request-submitted': {
    category: 'resource_updates',
    subject: (d) => `Resource Request Submitted — ${oneLine(d.resourceName)}`,
    badge: () => ({ text: 'Pending review', tone: 'pending' }),
    details: (d) => rows(row('Resource', `${d.resourceName} (${d.assetCode})`), row('Quantity', d.quantity),
                         row('Needed', `${d.requestedFrom} → ${d.requestedUntil}`), row('Purpose', d.purpose)),
    cta: () => 'Track my request',
  },
  'resource-request-submitted-admin': {
    category: 'resource_updates',
    subject: (d) => `New Resource Request Requires Review — ${oneLine(d.resourceName)}`,
    badge: () => ({ text: 'Needs review', tone: 'pending' }),
    details: (d) => rows(row('Student', d.studentName), row('Startup', d.startupTitle), row('Resource', `${d.resourceName} (${d.assetCode})`),
                         row('Quantity', d.quantity), row('Needed', `${d.requestedFrom} → ${d.requestedUntil}`), row('Purpose', d.purpose)),
    cta: () => 'Review requests',
  },
  'resource-request-approved': {
    category: 'resource_updates',
    subject: (d) => `Resource Request Approved — ${oneLine(d.resourceName)}`,
    badge: () => ({ text: 'Approved', tone: 'approved' }),
    details: (d) => rows(row('Resource', `${d.resourceName} (${d.assetCode})`), row('Status', 'Approved — awaiting handover')),
    cta: () => 'View my resources',
  },
  'resource-request-rejected': {
    category: 'resource_updates',
    subject: (d) => `Resource Request Update — ${oneLine(d.resourceName)}`,
    badge: () => ({ text: 'Rejected', tone: 'rejected' }),
    details: (d) => rows(row('Resource', d.resourceName), row('Status', 'Rejected')),
    cta: () => 'View my resources',
  },
  'resource-issued': {
    category: 'resource_updates',
    subject: (d) => `Resource Issued to You — ${oneLine(d.resourceName)}`,
    badge: () => ({ text: 'Issued', tone: 'approved' }),
    details: (d) => rows(row('Resource', `${d.resourceName} (${d.assetCode})`), row('Condition at issue', cap(String(d.condition).toLowerCase().replace(/_/g, ' '))), row('Due back', d.dueDate)),
    cta: () => 'View my resources',
  },
  'resource-returned': {
    category: 'resource_updates',
    subject: (d) => `Return Recorded — ${oneLine(d.resourceName)}`,
    badge: (d) => ({ text: d.clean ? 'Returned' : 'Returned — flagged', tone: d.clean ? 'approved' : 'pending' }),
    details: (d) => rows(row('Resource', `${d.resourceName} (${d.assetCode})`), row('Condition on return', cap(String(d.condition).toLowerCase().replace(/_/g, ' ')))),
    cta: () => 'View my resources',
  },
  'resource-issue-reported-admin': {
    category: 'resource_updates',
    subject: (d) => `Resource Issue Reported — ${oneLine(d.resourceName)}`,
    badge: () => ({ text: 'Needs review', tone: 'pending' }),
    details: (d) => rows(row('Resource', `${d.resourceName} (${d.assetCode})`), row('Reported by', d.reporterName),
                         row('Issue type', cap(String(d.issueType).toLowerCase().replace(/_/g, ' '))), row('Description', d.description)),
    cta: () => 'Review issues',
  },
  'resource-maintenance-started': {
    category: 'resource_updates',
    subject: (d) => `Maintenance Started — ${oneLine(d.resourceName)}`,
    details: (d) => rows(row('Resource', `${d.resourceName} (${d.assetCode})`), row('Status', 'In for repair')),
    cta: () => 'Browse resources',
  },
  'resource-maintenance-completed': {
    category: 'resource_updates',
    subject: (d) => `Maintenance Completed — ${oneLine(d.resourceName)}`,
    badge: () => ({ text: 'Available again', tone: 'approved' }),
    details: (d) => rows(row('Resource', `${d.resourceName} (${d.assetCode})`)),
    cta: () => 'Browse resources',
  },
  'resource-booking-submitted': {
    category: 'resource_updates',
    subject: (d) => `Booking Submitted — ${oneLine(d.resourceName)}`,
    badge: () => ({ text: 'Pending review', tone: 'pending' }),
    details: (d) => rows(row('Resource', `${d.resourceName} (${d.assetCode})`), row('Slot', d.slot), row('Purpose', d.purpose)),
    cta: () => 'View my bookings',
  },
  'resource-booking-submitted-admin': {
    category: 'resource_updates',
    subject: (d) => `New Booking Request — ${oneLine(d.resourceName)}`,
    badge: () => ({ text: 'Needs review', tone: 'pending' }),
    details: (d) => rows(row('Student', d.studentName), row('Resource', `${d.resourceName} (${d.assetCode})`), row('Slot', d.slot), row('Purpose', d.purpose)),
    cta: () => 'Review bookings',
  },
  'resource-booking-approved': {
    category: 'resource_updates',
    subject: (d) => `Booking Confirmed — ${oneLine(d.resourceName)}`,
    badge: () => ({ text: 'Confirmed', tone: 'approved' }),
    details: (d) => rows(row('Resource', d.resourceName), row('Slot', d.slot)),
    cta: () => 'View my bookings',
  },
  'resource-booking-rejected': {
    category: 'resource_updates',
    subject: (d) => `Booking Update — ${oneLine(d.resourceName)}`,
    badge: () => ({ text: 'Not approved', tone: 'rejected' }),
    details: (d) => rows(row('Resource', d.resourceName), row('Slot', d.slot)),
    cta: () => 'View my bookings',
  },
  'resource-overdue': {
    category: 'resource_updates',
    subject: (d) => `Overdue: ${oneLine(d.resourceName)} — Please Return`,
    badge: () => ({ text: 'Overdue', tone: 'rejected' }),
    details: (d) => rows(row('Resource', `${d.resourceName} (${d.assetCode})`), row('Was due', d.dueDate)),
    cta: () => 'View my resources',
  },
  'resource-return-reminder': {
    category: 'resource_updates',
    subject: (d) => `Reminder: ${oneLine(d.resourceName)} Due Back ${d.when === 'today' ? 'Today' : oneLine(d.when)}`,
    badge: () => ({ text: 'Return due', tone: 'pending' }),
    details: (d) => rows(row('Resource', `${d.resourceName} (${d.assetCode})`), row('Due', d.dueDate)),
    cta: () => 'View my resources',
  },
  'resource-booking-reminder': {
    category: 'resource_updates',
    subject: (d) => `Reminder: ${oneLine(d.resourceName)} Booking Tomorrow`,
    details: (d) => rows(row('Resource', d.resourceName), row('Slot', d.slot)),
    cta: () => 'View my bookings',
  },
};

export const TEMPLATE_KEYS = Object.keys(TEMPLATES);

export function templateMeta(key) {
  const t = TEMPLATES[key];
  if (!t) throw new Error(`Unknown email template: ${key}`);
  const category = t.category;
  return { key, category, mandatory: !!CATEGORIES[category]?.mandatory };
}

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                       .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const htmlToText = (html) => decode(html
  .replace(/<(style|head)[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|tr|h\d|div|li)>/gi, '\n')
  .replace(/<[^>]+>/g, ''))
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * @returns {{subject:string, html:string, text:string, category:string}}
 */
export async function renderEmail(key, data = {}) {
  const meta = templateMeta(key);
  const t = TEMPLATES[key];
  const base = (process.env.APP_BASE_URL || process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

  const subject = oneLine(t.subject(data));
  const details = t.details(data);
  const badge   = t.badge ? t.badge(data) : null;
  const cta     = data.url ? { label: t.cta(data), url: data.url } : null;

  const ctx = { ...data, appName: 'IncuPortal' };
  const body = await ejs.renderFile(path.join(DIR, `${key}.ejs`), ctx);

  const html = await ejs.renderFile(path.join(DIR, '_layout.ejs'), {
    subject, body, details, badge, cta,
    name: data.name || 'there',
    prefsUrl: `${base}/notifications/preferences`,
    showPrefsLink: !meta.mandatory,
    year: new Date().getFullYear(),
  });

  const text = [
    `Hello ${data.name || 'there'},`, '',
    htmlToText(body), '',
    ...details.map(([k, v]) => `${k}: ${v}`),
    ...(cta ? ['', `${cta.label}: ${cta.url}`] : []),
    '', 'Regards,', 'IncuPortal Incubation Cell',
    ...(meta.mandatory ? [] : ['', `Manage email preferences: ${base}/notifications/preferences`]),
  ].join('\n');

  return { subject, html, text, category: meta.category };
}
