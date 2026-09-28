/**
 * resourceReminderScheduler: the "automatic return reminders" job from the spec.
 *
 * A simple setInterval, not a new queue system — this project has no worker
 * infrastructure yet, and adding one just for two daily jobs would be the kind
 * of overengineering the brief explicitly warns against. Both jobs are cheap,
 * idempotent (dedupeKey in notificationService), and safe to run more than
 * once a day if the process restarts.
 *
 * Migration path: when this project eventually adds BullMQ/Agenda, replace the
 * body of run() with `queue.add('resource-reminders', {}, { repeat: {...} })`
 * and delete this file — nothing else changes, since all the real logic
 * (sendReturnReminders/sendBookingReminders) already lives in notificationService.
 */
import notificationService from './notificationService.js';

let timer = null;

async function run() {
  try {
    const [returns, bookings] = await Promise.all([
      notificationService.sendReturnReminders(),
      notificationService.sendBookingReminders(),
    ]);
    if (returns || bookings) console.log(`[reminders] sent ${returns || 0} return reminder(s), ${bookings || 0} booking reminder(s)`);
  } catch (err) {
    console.error('[reminders] run failed:', err.message);
  }
}

/**
 * Starts the job. Runs once shortly after boot (so a same-day restart doesn't
 * miss the day's reminders), then every `intervalMs` (default 6 hours — reminders
 * are date-based, not time-sensitive, so this doesn't need to be more frequent;
 * the dedupe key means re-running mid-day is a harmless no-op).
 */
export function startResourceReminders(intervalMs = 6 * 60 * 60 * 1000) {
  if (timer) return timer;                     // already running
  setTimeout(run, 30 * 1000);                   // let the app finish booting first
  timer = setInterval(run, intervalMs);
  return timer;
}

export function stopResourceReminders() {
  if (timer) { clearInterval(timer); timer = null; }
}
