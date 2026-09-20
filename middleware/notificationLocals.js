import { unreadCount } from '../service/notificationStore.js';

/** Puts `unreadCount` in res.locals for the bell badge. Never blocks a page on failure. */
export async function setNotificationLocals(req, res, next) {
  res.locals.unreadCount = 0;
  if (!req.user || req.path.startsWith('/notifications/recent')) return next();
  try {
    res.locals.unreadCount = await unreadCount(req.user.id);
  } catch (err) {
    console.error('[notifications] unread count failed:', err.message);
  }
  next();
}
