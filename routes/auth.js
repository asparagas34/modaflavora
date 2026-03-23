const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../database');

router.get('/giris', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null, redirect: req.query.redirect || '/' });
});

router.post('/giris', (req, res) => {
  const { email, password, redirect } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('login', { error: 'E-posta veya şifre hatalı', redirect: redirect || '/' });
  }

  req.session.user = { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin };
  res.redirect(redirect || '/');
});

router.get('/kayit', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('register', { error: null });
});

router.post('/kayit', (req, res) => {
  const { name, email, password, phone } = req.body;

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.render('register', { error: 'Bu e-posta adresi zaten kayıtlı' });
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (name, email, password, phone) VALUES (?, ?, ?, ?)')
    .run(name, email, hash, phone || null);

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  req.session.user = { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin };
  res.redirect('/');
});

router.get('/cikis', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

module.exports = router;
