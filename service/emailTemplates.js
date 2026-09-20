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
