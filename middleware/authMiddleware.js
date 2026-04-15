function requireLogin(req, res, next) {
  if (!req.isAuthenticated()) {
    req.flash('error', 'Please log in to continue.');
    return res.redirect('/auth/login');
  }
  next();
}

function requireCompleteProfile(req, res, next) {
  if (!req.isAuthenticated()) {
    req.flash('error', 'Please log in to continue.');
    return res.redirect('/auth/login');
  }
  if (!req.user.is_profile_complete) {
    return res.redirect('/auth/select-role');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAuthenticated()) {
    req.flash('error', 'Please log in to continue.');
    return res.redirect('/auth/login');
  }
  if (!req.user.is_profile_complete) {
    return res.redirect('/auth/select-role');
  }
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', {
      title: 'Access Denied',
      message: 'You do not have permission to access this page.',
      user: req.user
    });
  }
  next();
}

function requireMentor(req, res, next) {
  if (!req.isAuthenticated()) {
    req.flash('error', 'Please log in to continue.');
    return res.redirect('/auth/login');
  }
  if (!req.user.is_profile_complete) {
    return res.redirect('/auth/select-role');
  }
  if (req.user.role !== 'mentor') {
    return res.status(403).render('error', {
      title: 'Access Denied',
      message: 'Only mentors can access this page.',
      user: req.user
    });
  }
  next();
}

function requireStudent(req, res, next) {
  if (!req.isAuthenticated()) {
    req.flash('error', 'Please log in to continue.');
    return res.redirect('/auth/login');
  }
  if (!req.user.is_profile_complete) {
    return res.redirect('/auth/select-role');
  }
  if (req.user.role !== 'student') {
    return res.status(403).render('error', {
      title: 'Access Denied',
      message: 'Only students can access this page.',
      user: req.user
    });
  }
  next();
}

// Set locals for all views — uses req.user (Passport) 
function setLocals(req, res, next) {
  res.locals.user       = req.user || null;
  res.locals.successMsg = req.flash('success');
  res.locals.errorMsg   = req.flash('error');
  next();
}

export { requireLogin, requireCompleteProfile, requireAdmin, requireMentor, requireStudent, setLocals };