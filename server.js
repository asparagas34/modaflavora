const express = require('express');
const session = require('express-session');
const compression = require('compression');
const path = require('path');
const { initDatabase, getSettings, db } = require('./database');
const { initBot } = require('./telegram');
const { trackRequest } = require('./tracker');
const { startAbandonedCartChecker } = require('./abandoned-cart');
const { initWhatsApp } = require('./whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database
initDatabase();

// Telegram bot başlat
initBot();

// Terk edilen sepet otomasyonunu başlat
startAbandonedCartChecker();

// WhatsApp hatırlatma sistemini başlat
initWhatsApp();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Security: X-Powered-By header gizle
app.disable('x-powered-by');

// Gzip compression
app.use(compression());

// Static files with cache headers
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
    if (filePath.match(/\.(jpg|jpeg|png|gif|webp|svg|ico)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000');
    }
  }
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '30d',
  etag: true
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: 'butik-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Anlık takip middleware
app.use((req, res, next) => {
  try { trackRequest(req); } catch (e) {}
  next();
});

// Cache: settings ve kategoriler her request'te DB'ye sorulmaz
let _settingsCache = null;
let _settingsCacheTime = 0;
let _categoriesCache = null;
let _categoriesCacheTime = 0;
const CACHE_TTL = 10000; // 10 saniye

function getCachedSettings() {
  const now = Date.now();
  if (!_settingsCache || now - _settingsCacheTime > CACHE_TTL) {
    _settingsCache = getSettings();
    _settingsCacheTime = now;
  }
  return _settingsCache;
}

function getCachedCategories() {
  const now = Date.now();
  if (!_categoriesCache || now - _categoriesCacheTime > CACHE_TTL) {
    _categoriesCache = db.prepare('SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order').all();
    _categoriesCacheTime = now;
  }
  return _categoriesCache;
}

// Admin ayar kaydettiğinde cache'i temizle
app.use('/admin/ayarlar', (req, res, next) => {
  if (req.method === 'POST') { _settingsCache = null; }
  next();
});
app.use('/admin/kategori', (req, res, next) => {
  if (req.method === 'POST') { _categoriesCache = null; }
  next();
});

// Global middleware - pass settings and user to all views
app.use((req, res, next) => {
  res.locals.settings = getCachedSettings();
  res.locals.user = req.session.user || null;
  res.locals.cart = req.session.cart || [];
  res.locals.cartCount = (req.session.cart || []).reduce((sum, item) => sum + item.quantity, 0);
  res.locals.currentPath = req.path;
  res.locals.allCategories = getCachedCategories();
  next();
});

// Routes
app.use('/', require('./routes/shop'));
app.use('/admin', require('./routes/admin'));
app.use('/api', require('./routes/api'));
app.use('/auth', require('./routes/auth'));

// 404
app.use((req, res) => {
  res.status(404).render('404');
});

app.listen(PORT, () => {
  console.log(`Butik sitesi çalışıyor: http://localhost:${PORT}`);
  console.log(`Admin paneli: http://localhost:${PORT}/admin`);
  console.log(`Admin giriş: admin@flavora.com / admin123`);
});
