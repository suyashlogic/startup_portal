import express from "express";
import passport from "passport";
import bcrypt from "bcrypt";
import { Strategy } from "passport-local";
import GoogleStrategy from "passport-google-oauth20";
import db from '../config/db.js';

import crypto from "crypto";
import { sendPasswordResetEmail } from "../service/email.js";

const saltRounds = 10;
const router = express.Router();

function isStrongPassword(password) {
  if (password.length < 8)
    return { valid: false, message: "Password must be at least 8 characters long" };
  if (!/[a-z]/.test(password))
    return { valid: false, message: "Password must include at least one lowercase letter" };
  if (!/[A-Z]/.test(password))
    return { valid: false, message: "Password must include at least one uppercase letter" };
  if (!/\d/.test(password))
    return { valid: false, message: "Password must include at least one number" };
  if (!/[@$!%*?&]/.test(password))
    return { valid: false, message: "Password must include at least one special character (@$!%*?&)" };
  return { valid: true, message: "Password is strong" };
}

function dashboardRedirect(role) {
  if (role === 'admin')  return '/admin/dashboard';
  if (role === 'mentor') return '/mentor/dashboard';
  return '/student/dashboard';
}

passport.use("local",
  new Strategy(
    { usernameField: "email" },
    async function verify(username, password, cb) {
      try {
        const result = await db.query("SELECT * FROM users WHERE email = $1", [username]);

        if (result.rows.length === 0) {
          return cb(null, false, { message: 'Invalid email or password.' });
        }

        const user = result.rows[0];

        // Block Google-only accounts from password login
        if (user.auth_provider === 'google' && !user.password_hash) {
          return cb(null, false, { message: 'This account uses Google Sign-In. Please login with Google.' });
        }

        bcrypt.compare(password, user.password_hash, (err, valid) => {
          if (err) return cb(err);
          if (valid) return cb(null, user);
          return cb(null, false, { message: 'Invalid email or password.' });
        });

      } catch (err) {
        return cb(err);
      }
    }
  )
);

// Passport: Google 
passport.use(
  "google",
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "http://localhost:3000/auth/google/portal/callback",
      passReqToCallback: true,
    },
    async (req, accessToken, refreshToken, profile, cb) => {
      try {
        const email    = profile.emails[0].value;
        const googleId = profile.id;
        const name     = profile.displayName;

        const role = req.session.pendingRole || null;
        delete req.session.pendingRole;

        const result = await db.query(
          "SELECT * FROM users WHERE email = $1",
          [email]
        );

        let user;

        if (result.rows.length > 0) {
          user = result.rows[0];

          if (!user.google_id) {
            await db.query(
              `UPDATE users SET auth_provider = 'google', google_id = $1 WHERE id = $2`,
              [googleId, user.id]
            );
            user.google_id     = googleId;
            user.auth_provider = 'google';
          }

        } else {
          // New user — assign role immediately 
          const hasRole = ["student", "mentor"].includes(role);

          const newUser = await db.query(
            `INSERT INTO users
               (name, email, password_hash, auth_provider, google_id, role, is_profile_complete)
             VALUES ($1, $2, NULL, 'google', $3, $4, $5)
             RETURNING *`,
            [name, email, googleId, hasRole ? role : null, hasRole]
          );

          user = newUser.rows[0];
        }

        return cb(null, user);
      } catch (err) {
        return cb(err);
      }
    }
  )
);

passport.serializeUser((user, cb) => {
  cb(null, user.id);
});

passport.deserializeUser(async (id, cb) => {
  try {
    const result = await db.query("SELECT * FROM users WHERE id = $1", [id]);
    if (result.rows.length === 0) return cb(null, false);
    cb(null, result.rows[0]);
  } catch (err) {
    cb(err);
  }
});


router.get("/google/student", (req, res, next) => {
  req.session.pendingRole = "student";
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

router.get("/google/mentor", (req, res, next) => {
  req.session.pendingRole = "mentor";
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

router.get("/google", (req, res, next) => {
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

router.get(
  "/google/portal/callback",
  passport.authenticate("google", { failureRedirect: "/auth/login" }),
  (req, res) => {
    if (!req.user.is_profile_complete) return res.redirect("/auth/select-role");
    return res.redirect(dashboardRedirect(req.user.role));
  }
);

router.get('/login', (req, res) => {
  res.render('auth/login', { title: 'Login' });
});

router.get('/register', (req, res) => {
  res.render('auth/register', { title: 'Register' });
});

router.post('/register', async (req, res) => {
  const { name, email, password, confirmPassword, role } = req.body;

  if (!name || !email || !password || !role) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/auth/register');
  }
  if (password !== confirmPassword) {
    req.flash('error', 'Passwords do not match.');
    return res.redirect('/auth/register');
  }
  const passwordValidation = isStrongPassword(password);
  if (!passwordValidation.valid) {
    req.flash('error', passwordValidation.message);
    return res.redirect('/auth/register');
  }
  if (!['student', 'mentor'].includes(role)) {
    req.flash('error', 'Invalid role selected.');
    return res.redirect('/auth/register');
  }

  try {
    const checkResult = await db.query("SELECT * FROM users WHERE email = $1", [email]);
    if (checkResult.rows.length > 0) {
      req.flash('error', 'Email is already registered. Please log in.');
      return res.redirect('/auth/register');
    }

    bcrypt.hash(password, saltRounds, async (err, hash) => {
      if (err) {
        console.error("Error hashing password:", err);
        req.flash('error', 'Something went wrong. Please try again.');
        return res.redirect('/auth/register');
      }

      const result = await db.query(
        `INSERT INTO users (name, email, password_hash, role, auth_provider, is_profile_complete)
         VALUES ($1, $2, $3, $4, 'local', true)
         RETURNING id, name, email, role, is_profile_complete`,
        [name, email, hash, role]
      );

      const user = result.rows[0];
      req.login(user, (err) => {
        if (err) {
          console.error("Login error:", err);
          return res.redirect('/auth/login');
        }
        req.flash('success', `Welcome, ${name}! Your account has been created.`);
        return res.redirect(dashboardRedirect(role));
      });
    });

  } catch (err) {
    console.error('Register error:', err);
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/auth/register');
  }
});

router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      req.flash('error', info?.message || 'Invalid email or password.');
      return res.redirect('/auth/login');
    }
    req.logIn(user, (err) => {
      if (err) return next(err);
      req.flash('success', `Welcome back, ${user.name}!`);
      if (!user.is_profile_complete) return res.redirect('/auth/select-role');
      return res.redirect(dashboardRedirect(user.role));
    });
  })(req, res, next);
});

router.get('/select-role', (req, res) => {
  if (!req.user) return res.redirect('/auth/login');
  if (req.user.is_profile_complete) return res.redirect(dashboardRedirect(req.user.role));
  res.render('auth/select-role', { title: 'Choose Your Role' });
});

router.post('/select-role', async (req, res) => {
  if (!req.user) return res.redirect('/auth/login');
  if (req.user.is_profile_complete) return res.redirect(dashboardRedirect(req.user.role));

  const { role } = req.body;
  if (!['student', 'mentor'].includes(role)) {
    req.flash('error', 'Please select a valid role.');
    return res.redirect('/auth/select-role');
  }

  try {
    await db.query(
      'UPDATE users SET role=$1, is_profile_complete=true WHERE id=$2',
      [role, req.user.id]
    );
    req.flash('success', `You're all set as a ${role}!`);
    return res.redirect(dashboardRedirect(role));
  } catch (err) {
    console.error('Role selection error:', err);
    req.flash('error', 'Something went wrong. Please try again.');
    return res.redirect('/auth/select-role');
  }
});

router.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect('/auth/login'));
  });
});


router.get("/forgot-password", (req, res) => {
  res.render("auth/forgot-password", { title: "Forgot Password" });
});

router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  try {

    const result = await db.query(
      "SELECT id, name, email FROM users WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.render("auth/forgot-password", {
        error: "If this email exists, a reset link will be sent."
      });
    }

    const user = result.rows[0];

    /* ---------- STEP 2: CREATE TOKEN ---------- */

    const resetToken = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    /* ---------- STEP 3: SAVE TOKEN ---------- */

    await db.query(
      `
      UPDATE users
      SET reset_token = $1,
          reset_token_expiry = $2
      WHERE id = $3
      `,
      [resetToken, expiry, user.id]
    );

    const baseUrl   = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const resetLink = `${baseUrl}/auth/reset-password/${resetToken}`;


    await sendPasswordResetEmail({
      email: user.email,
      name: user.name,
      resetLink
    });


    res.render("auth/forgot-password", {
      success: "If this email exists, a reset link has been sent."
    });

  } catch (error) {
    console.error(error);
    res.render("auth/forgot-password", {
      error: "Something went wrong. Please try again later."
    });
  }
});

router.get("/reset-password/:token", async (req, res) => {
  const { token } = req.params;

  try {
    const result = await db.query(
      `
      SELECT id
      FROM users
      WHERE reset_token = $1
        AND reset_token_expiry > NOW()
      `,
      [token]
    );

    if (result.rows.length === 0) {
      return res.render("auth/reset-password", {
        token,
        error: "Reset link is invalid or has expired."
      });
    }
    res.render("auth/reset-password", { token });

  } catch (error) {
    console.error(error);
    res.render("auth/reset-password", {
      token,
      error: "Something went wrong."
    });
  }
});

router.post("/reset-password/:token", async (req, res) => {
  const { token } = req.params;
  const { password, confirmPassword } = req.body;

  try {

    if (password !== confirmPassword) {
      return res.render("auth/reset-password", {
        token,
        error: "Passwords do not match."
      });
    }

    const result = await db.query(
      `
      SELECT id
      FROM users
      WHERE reset_token = $1
        AND reset_token_expiry > NOW()
      `,
      [token]
    );

    if (result.rows.length === 0) {
      return res.render("auth/reset-password", {
        token,
        error: "Reset link is invalid or has expired."
      });
    }

    const userId = result.rows[0].id;

    const hashedPassword = await bcrypt.hash(password, 10);

    await db.query(
      `
      UPDATE users
      SET password_hash = $1,
          reset_token = NULL,
          reset_token_expiry = NULL
      WHERE id = $2
      `,
      [hashedPassword, userId]
    );

    res.render("auth/reset-password", {
      token,
      success: "Password reset successful. You can now log in."
    });

  } catch (error) {
    console.error(error);
    res.render("auth/reset-password", {
      token,
      error: "Something went wrong. Please try again."
    });
  }
});


export default router;