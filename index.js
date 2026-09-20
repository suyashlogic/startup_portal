import express from 'express';
import session from 'express-session';
import flash from 'connect-flash';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import { setLocals } from './middleware/authMiddleware.js';
import { setNotificationLocals } from './middleware/notificationLocals.js';   // NEW
import passport from 'passport';
import authRoutes          from './routes/auth.js';
import studentRoutes       from './routes/student.js';
import adminRoutes         from './routes/admin.js';
import mentorRoutes        from './routes/mentor.js';
import marketingRoutes     from './routes/marketing.js';
import notificationRoutes  from './routes/notifications.js';                   // NEW
import { drain }           from './service/notificationService.js';            // NEW

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: true,
  saveUninitialized: true,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24, //1day
    httpOnly: true
  }
}));

app.use(flash());

app.use(passport.initialize());
app.use(passport.session());

app.use(setLocals);
app.use(setNotificationLocals);                                                // NEW: sets res.locals.unreadCount

app.use('/',              marketingRoutes);
app.use('/auth',          authRoutes);
app.use('/student',       studentRoutes);
app.use('/admin',         adminRoutes);
app.use('/mentor',        mentorRoutes);
app.use('/notifications', notificationRoutes);                                 // NEW

app.use((req, res) => {
  res.status(404).render('error', {
    title: '404 - Page Not Found',
    message: 'The page you are looking for does not exist.',
    user: req.user || null
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).render('error', {
    title: 'Server Error',
    message: 'Something went wrong. Please try again later.',
    user: req.user || null
  });
});

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// Let queued emails finish before the process exits (Ctrl+C / deploy restarts).
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await drain();
    process.exit(0);
  });
}
