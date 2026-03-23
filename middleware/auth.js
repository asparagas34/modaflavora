function isAuthenticated(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/auth/giris');
}

function isAdmin(req, res, next) {
  if (req.session.user && req.session.user.is_admin) return next();
  res.redirect('/auth/giris?redirect=/admin');
}

module.exports = { isAuthenticated, isAdmin };
