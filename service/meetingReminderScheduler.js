/**
 * meetingReminderScheduler: same pattern as resourceReminderScheduler.js —
 * a plain setInterval, not a new queue system. Two cheap, idempotent jobs:
 *   1. 24h-before email/in-app reminders (sendMeetingReminders)
 *   2. flagging meetings nobody ever marked completed as NO_SHOW, well after
 *      they ended, so they stop cluttering "upcoming" (markStaleAsNoShow)
 *
 * Runs every hour — reminders have a wide 23-25h matching window so an
 * hourly cadence never misses one, and a restart mid-day is a harmless
 * no-op thanks to reminder_24h_sent_at / the NO_SHOW status check.
 */
import notificationService from './notificationService.js';
import { markStaleAsNoShow } from './meetingService.js';

let timer = null;

async function run() {
  try {
    const [reminders, staleRows] = await Promise.all([
      notificationService.sendMeetingReminders(),
      markStaleAsNoShow(6),
    ]);
    if (reminders || staleRows.length) {
      console.log(`[meeting-reminders] sent ${reminders || 0} reminder(s), flagged ${staleRows.length} stale meeting(s) as no-show`);
    }
  } catch (err) {
    console.error('[meeting-reminders] run failed:', err.message);
  }
}

export function startMeetingReminders(intervalMs = 60 * 60 * 1000) {
  if (timer) return timer;
  setTimeout(run, 45 * 1000);   // let the app finish booting first
  timer = setInterval(run, intervalMs);
  return timer;
}

export function stopMeetingReminders() {
  if (timer) { clearInterval(timer); timer = null; }
}
