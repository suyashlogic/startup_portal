# 🎓 IncuPortal — Student Startup Incubation System

A full-stack web application for managing student startup ideas through an incubation pipeline — from submission and mentor assignment to funding approvals.

---

## 📸 Overview

IncuPortal connects three types of users:

| Role | What they do |
|------|-------------|
| **Student** | Submit startup ideas, track approval status, post progress updates, request funding |
| **Mentor** | View assigned startups, give structured feedback |
| **Admin** | Approve/reject startups, assign mentors, manage funding requests, manage users |

---

## 🧱 Tech Stack

- **Backend:** Node.js, Express.js
- **Database:** PostgreSQL
- **Auth:** Passport.js (Local + Google OAuth 2.0)
- **Templating:** EJS
- **CSS:** Bootstrap 5 + custom CSS
- **File Uploads:** Multer
- **Email:** Nodemailer
- **Session:** express-session + connect-flash

---

## ✅ Prerequisites

Make sure the following are installed on your machine:

- [Node.js](https://nodejs.org/) v18 or higher
- [PostgreSQL](https://www.postgresql.org/) v14 or higher
- A Gmail account (or any SMTP provider) for sending password reset emails
- A Google Cloud project (for Google OAuth — optional but recommended)

---

## 🚀 Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/your-username/incuportal.git
cd incuportal
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up the database

Log into PostgreSQL and create a database:

```sql
CREATE DATABASE incuportal;
```

Then run the schema file to create all tables:

```bash
psql -U your_pg_username -d incuportal -f schema.sql
```

### 4. Configure environment variables

Create a `.env` file in the root of the project:

```bash
cp .env.example .env
```

Then fill in the values (see the section below).

### 5. Start the server

```bash
node index.js
```

Or with auto-reload during development:

```bash
npm install -g nodemon
nodemon index.js
```

The app will be running at **http://localhost:3000**

---

## ⚙️ Environment Variables

Create a `.env` file in the project root with the following variables:

```env
# ── Server ────────────────────────────────────
PORT=3000

# ── PostgreSQL ────────────────────────────────
PG_USER=your_postgres_username
PG_HOST=localhost
PG_DATABASE=incuportal
PG_PASSWORD=your_postgres_password
PG_PORT=5432

# ── Session ───────────────────────────────────
# Generate a random secret: run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
SESSION_SECRET=your_super_secret_session_key

# ── Google OAuth 2.0 ──────────────────────────
# Get these from https://console.cloud.google.com/
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# ── Email (for password reset) ────────────────
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your_email@gmail.com
EMAIL_PASSWORD=your_app_password   # Use Gmail App Password, not your real password

# ── App Base URL ──────────────────────────────
BASE_URL=http://localhost:3000
```

---

## 🔐 Setting Up Google OAuth (Optional)

If you want Google Sign-In to work:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client IDs**
4. Set application type to **Web application**
5. Under **Authorized redirect URIs**, add:
   ```
   http://localhost:3000/auth/google/portal/callback
   ```
6. Copy the **Client ID** and **Client Secret** into your `.env` file

> If you skip this step, just leave `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` empty — email/password login will still work fine.

---

## 📧 Setting Up Email (Gmail)

To enable password reset emails:

1. Enable **2-Step Verification** on your Google account
2. Go to [Google App Passwords](https://myaccount.google.com/apppasswords)
3. Generate an app password for "Mail"
4. Use that generated password as `EMAIL_PASSWORD` in `.env`

> Never use your actual Gmail password here.

---

## 📁 Project Structure

```
incuportal/
├── config/
│   └── db.js                  # PostgreSQL connection
├── middleware/
│   ├── authMiddleware.js      # Role guards (requireAdmin, requireStudent, etc.)
│   └── upload.js              # Multer config for file uploads
├── routes/
│   ├── auth.js                # Login, register, Google OAuth, password reset
│   ├── student.js             # Student dashboard, startup CRUD, funding
│   ├── mentor.js              # Mentor dashboard, feedback
│   └── admin.js               # Admin panel, startup approval, user management
├── service/
│   └── email.js               # Nodemailer setup & password reset email
├── views/
│   ├── auth/                  # Login, register, forgot/reset password, role select
│   ├── student/               # Student dashboard, my-startups, startup-detail, submit
│   ├── mentor/                # Mentor dashboard, feedback, startup-detail
│   ├── admin/                 # Admin dashboard, startups, funding, users, startup-detail
│   └── layouts/               # Shared sidebar, flash messages
├── public/
│   ├── css/style.css          # Global styles
│   └── uploads/               # Uploaded pitch decks & proposals (auto-created)
├── schema.sql                 # Database schema — run this first
├── index.js                   # App entry point
└── .env                       # Your environment config (not committed)
```

---

## 🗄️ Database Schema

The app uses 5 tables:

| Table | Purpose |
|-------|---------|
| `users` | Stores all users with role, auth provider, and optional reset token |
| `startups` | Student startup submissions with status and admin remarks |
| `mentor_assignments` | Many-to-many link between startups and mentors |
| `progress_updates` | Timeline of updates posted on a startup |
| `mentor_feedback` | Feedback entries from mentors on startups |
| `funding_requests` | Funding applications submitted by students |

> **Note:** The `users` table needs two extra columns for password reset. If you run into errors, add them manually:
> ```sql
> ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255);
> ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expiry TIMESTAMP;
> ```

---

## 👤 Creating Your First Admin

There is no admin registration through the UI (by design). To make someone an admin:

1. Register a normal account via `/auth/register`
2. Open your PostgreSQL client and run:

```sql
UPDATE users SET role = 'admin', is_profile_complete = true WHERE email = 'your@email.com';
```

Now log in — you'll be redirected to the Admin Dashboard.

---

## 📦 Key Features

- **Role-based access control** — Students, Mentors, and Admins each see only their relevant pages
- **Google OAuth + Local auth** — Users can sign in with Google or email/password
- **Password reset via email** — Secure token-based flow with 1-hour expiry
- **File uploads** — Pitch decks (PDF, PPT, DOC) and funding proposals with size/type validation
- **Admin review workflow** — Approve or reject startups with optional remarks
- **Mentor assignment** — Admin can assign multiple mentors to a startup
- **Progress timeline** — Students post updates; mentors and admins see a timeline
- **Funding requests** — Students on approved startups can apply for seed funding
- **Client-side filters** — Search/filter startups by status, stage, and domain (no page reload)
- **AngularJS validation** — Login and register forms have real-time client-side validation

---

## 🛠️ Common Issues

**`relation "users" does not exist`**
→ You haven't run `schema.sql` yet. See Step 3 in Getting Started.

**`Cannot find module '../config/db.js'`**
→ Make sure your folder structure matches — `config/db.js`, `routes/auth.js`, etc.

**Google OAuth redirect mismatch**
→ The callback URL in Google Console must exactly match `http://localhost:3000/auth/google/portal/callback`

**Email not sending**
→ Make sure you're using a Gmail **App Password**, not your real Gmail password. Also confirm `EMAIL_HOST=smtp.gmail.com` and `EMAIL_PORT=587`.

**Uploads not working**
→ Make sure the `public/uploads/` directory exists. Create it if needed:
```bash
mkdir -p public/uploads
```

---

## 📄 License

MIT — feel free to use, modify, and build on this project.
