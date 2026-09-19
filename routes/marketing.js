import express from "express";

const router = express.Router();

function dashboardRedirect(role) {
  if (role === 'admin')  return '/admin/dashboard';
  if (role === 'mentor') return '/mentor/dashboard';
  return '/student/dashboard';
}

/* ── Home ──────────────────────────────────────────────────────────────
   Logged-in users go straight to their dashboard (existing behaviour).
   Everyone else sees the public marketing home page instead of being
   forced to /auth/login. */
router.get('/', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.redirect(dashboardRedirect(req.user.role));
  }

  res.render('marketing/home', {
    title: 'Home',

    // Placeholder sample — swap for a real "featured" query against the
    // startups table (e.g. status = 'approved' ORDER BY created_at) before launch.
    featuredStartups: [
      { tag: 'FINTECH', name: 'PayTrack', role: 'BBA team, 3rd year', desc: 'Expense-splitting for hostel and mess payments.' },
      { tag: 'EDTECH', name: 'StudyLoop', role: 'MBA-Tech team', desc: 'Peer note-sharing with spaced-repetition revision.' },
      { tag: 'AI', name: 'ClauseCheck', role: 'Law + CS team', desc: 'Plain-language contract summaries for freelancers.' },
      { tag: 'SUSTAINABILITY', name: 'ReLeaf', role: 'Engineering team', desc: 'Campus composting logistics for hostels.' }
    ],

    // Placeholder — real physical spaces on campus, not fabricated facilities,
    // but confirm exact names/descriptions with the incubation office.
    facilities: [
      { icon: '🛠️', title: 'Prototyping lab', desc: 'Basic hardware and 3D printing access for early builds.' },
      { icon: '🤝', title: 'Mentor meeting rooms', desc: 'Bookable rooms for one-on-one mentor sessions.' },
      { icon: '💻', title: 'Co-working floor', desc: 'Desk space for incubated teams, open during campus hours.' },
      { icon: '🎤', title: 'Demo stage', desc: 'Where pitch days and demo days actually happen.' }
    ],

    // IMPORTANT: these are placeholder quotes for layout purposes only —
    // replace with real, attributed founder testimonials before this goes live.
    testimonials: [
      { quote: 'Sample quote — replace with a real founder testimonial before launch.', initials: 'AA', name: 'Placeholder name', role: 'Student founder, sample', company: 'Sample Startup' },
      { quote: 'Sample quote — replace with a real founder testimonial before launch.', initials: 'BB', name: 'Placeholder name', role: 'Student founder, sample', company: 'Sample Startup' },
      { quote: 'Sample quote — replace with a real founder testimonial before launch.', initials: 'CC', name: 'Placeholder name', role: 'Student founder, sample', company: 'Sample Startup' },
      { quote: 'Sample quote — replace with a real founder testimonial before launch.', initials: 'DD', name: 'Placeholder name', role: 'Student founder, sample', company: 'Sample Startup' }
    ]
  });
});

/* ── Students (journey template) ─────────────────────────────────────── */
router.get('/students', (req, res) => {
  res.render('marketing/journey', {
    title: 'Students',
    eyebrow: 'For students',
    heading: "Your idea starts here.",
    sub: "Everything a student needs to go from a rough idea to a startup with a mentor, a plan and a track record.",
    steps: [
      { title: 'Submit your idea', desc: 'A short form — title, description, domain, stage. Ten minutes, no pitch deck required to start.' },
      { title: 'Get reviewed', desc: 'The admin team reads every submission and responds with a decision and feedback.' },
      { title: 'Find a mentor', desc: 'Approved ideas get matched with a mentor from the network who has relevant expertise.' },
      { title: 'Build your prototype', desc: 'Post progress updates as you build — your mentor and the admin team can see them.' },
      { title: 'Apply for funding', desc: 'Once approved, request funding for specific needs with a clear purpose and proposal.' },
      { title: 'Track everything', desc: 'One dashboard for status, feedback, funding requests and next steps.' }
    ],
    cta: { heading: 'Have an idea already?', sub: 'Submission takes about ten minutes.', href: '/apply', label: 'Submit your idea' }
  });
});

/* ── Programs (journey template) ─────────────────────────────────────── */
router.get('/programs', (req, res) => {
  res.render('marketing/journey', {
    title: 'Programs',
    eyebrow: 'Programs',
    heading: 'Three stages, one continuous journey.',
    sub: 'From an unproven idea to a business ready to scale — each stage has a different kind of support attached to it.',
    steps: [
      { title: 'Pre-incubation', desc: 'For raw ideas. Focus is on problem validation and talking to real users before building anything.' },
      { title: 'Incubation', desc: 'For validated ideas with a founding team. Structured mentorship, workspace and milestone tracking.' },
      { title: 'Acceleration', desc: 'For startups with early traction. Investor readiness, pitch practice and growth-stage support.' }
    ],
    cta: { heading: 'Not sure which stage you\'re at?', sub: 'Submit your idea and the admin team will place you correctly.', href: '/apply', label: 'Submit your idea' }
  });
});

/* ── Founders / Startups directory ──────────────────────────────────── */
const startupItems = [
  { tag: 'FINTECH', name: 'PayTrack', role: 'Founded by 3rd-year BBA team', desc: 'A student expense-splitting app built for hostel and mess payments.', category: 'fintech', accent: 'cyan', tags: ['Approved', 'MVP'] },
  { tag: 'EDTECH', name: 'StudyLoop', role: 'Founded by MBA-Tech students', desc: 'Peer-to-peer note sharing with spaced-repetition revision built in.', category: 'edtech', accent: 'amber', tags: ['Approved', 'Scaling'] },
  { tag: 'HEALTHTECH', name: 'VitalSign', role: 'Founded by Pharmacy students', desc: 'A medication-reminder app designed around Indian generic drug names.', category: 'healthtech', accent: '', tags: ['Prototype'] },
  { tag: 'SUSTAINABILITY', name: 'ReLeaf', role: 'Founded by Engineering students', desc: 'Campus composting logistics for hostels and the cafeteria.', category: 'sustainability', accent: 'cyan', tags: ['Idea'] },
  { tag: 'AI', name: 'ClauseCheck', role: 'Founded by Law + CS team', desc: 'Plain-language contract summarisation for first-time freelancers.', category: 'ai', accent: 'amber', tags: ['Approved'] },
  { tag: 'CONSUMER', name: 'ThriftLoop', role: 'Founded by Design students', desc: 'A campus-only marketplace for second-hand textbooks and hostel gear.', category: 'consumer', accent: '', tags: ['MVP'] }
];

router.get('/founders', (req, res) => {
  res.render('marketing/directory', {
    title: 'Founders',
    eyebrow: 'Startup directory',
    heading: 'Founders building right now.',
    sub: 'A snapshot of student ventures currently moving through the incubation ecosystem.',
    filters: [
      { label: 'FinTech', value: 'fintech' }, { label: 'EdTech', value: 'edtech' },
      { label: 'HealthTech', value: 'healthtech' }, { label: 'Sustainability', value: 'sustainability' },
      { label: 'AI', value: 'ai' }, { label: 'Consumer', value: 'consumer' }
    ],
    items: startupItems,
    cta: { heading: 'Building something of your own?', sub: 'Submit it and get in front of a mentor.', href: '/apply', label: 'Submit your idea' }
  });
});

router.get('/startups', (req, res) => {
  res.render('marketing/directory', {
    title: 'Startup Showcase',
    eyebrow: 'Showcase',
    heading: 'The portfolio so far.',
    sub: 'Ventures that have come through the incubation ecosystem — from first prototype to scale.',
    filters: [
      { label: 'FinTech', value: 'fintech' }, { label: 'EdTech', value: 'edtech' },
      { label: 'HealthTech', value: 'healthtech' }, { label: 'AI', value: 'ai' }
    ],
    items: startupItems
  });
});

/* ── Mentors directory ────────────────────────────────────────────────── */
router.get('/mentors', (req, res) => {
  res.render('marketing/directory', {
    title: 'Mentors',
    eyebrow: 'Mentor network',
    heading: 'Experience that moves ideas forward.',
    sub: 'Mentors are matched to approved startups once they enter incubation — not assigned before review.',
    filters: [
      { label: 'Business', value: 'business' }, { label: 'Technology', value: 'technology' },
      { label: 'Finance', value: 'finance' }, { label: 'Product', value: 'product' }
    ],
    items: [
      { tag: 'BUSINESS STRATEGY', name: 'Ecosystem mentors', role: 'Alumni founders & operators', desc: 'Guidance on positioning, go-to-market and early hiring decisions.', category: 'business', accent: '' },
      { tag: 'TECHNOLOGY', name: 'Technical mentors', role: 'Engineers & CTOs', desc: 'Architecture reviews, build-vs-buy calls, and technical roadmap sanity checks.', category: 'technology', accent: 'cyan' },
      { tag: 'FINANCE', name: 'Finance mentors', role: 'CAs & early-stage investors', desc: 'Unit economics, runway planning and how to read a term sheet.', category: 'finance', accent: 'amber' },
      { tag: 'PRODUCT', name: 'Product mentors', role: 'Product managers & designers', desc: 'Scoping an MVP that actually tests the riskiest assumption first.', category: 'product', accent: '' }
    ],
    cta: { heading: 'Want to mentor a student founder?', sub: 'Reach out to the incubation team to join the network.', href: 'mailto:incubation@nmims.edu', label: 'Get in touch' }
  });
});

/* ── Faculty directory ───────────────────────────────────────────────── */
router.get('/faculty', (req, res) => {
  res.render('marketing/directory', {
    title: 'Faculty',
    eyebrow: 'Faculty',
    heading: 'Faculty that turns knowledge into innovation.',
    sub: 'Faculty across departments who mentor, research and connect students into the ecosystem.',
    filters: [
      { label: 'Entrepreneurship', value: 'entrepreneurship' }, { label: 'Technology', value: 'technology' },
      { label: 'Business', value: 'business' }, { label: 'Research', value: 'research' }
    ],
    items: [] // wire this to a real faculty data source before launch — left empty rather than fabricated
  });
});

/* ── Events ───────────────────────────────────────────────────────────── */
router.get('/events', (req, res) => {
  res.render('marketing/list', {
    title: 'Events',
    eyebrow: 'Events',
    heading: 'Where the ecosystem shows up.',
    sub: 'Workshops, pitch days and mentor sessions across the incubation calendar.',
    items: [] // wire to a real events source — intentionally empty, not fabricated
  });
});

/* ── Resources ────────────────────────────────────────────────────────── */
router.get('/resources', (req, res) => {
  res.render('marketing/list', {
    title: 'Resources',
    eyebrow: 'Resources',
    heading: 'Guides, templates and reference material.',
    sub: 'Everything a first-time founder wishes someone had handed them earlier.',
    items: []
  });
});

/* ── Success stories ──────────────────────────────────────────────────── */
router.get('/success-stories', (req, res) => {
  res.render('marketing/list', {
    title: 'Success Stories',
    eyebrow: 'Success stories',
    heading: 'Ventures that made it through.',
    sub: 'Founders who went from a first submission to a working business.',
    items: []
  });
});

/* ── Apply ────────────────────────────────────────────────────────────── */
router.get('/apply', (req, res) => {
  res.render('marketing/apply', { title: 'Apply' });
});

export default router;
